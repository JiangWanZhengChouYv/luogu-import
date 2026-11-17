/**
 * 数据范围识别模型（中英双语）。
 *
 * 解决的问题：题面「提示 / 数据范围 / Constraints」里会写很多上界，
 * 例如 P1048 的 `M <= 100` 与 `a <= 10^9` 混在一起。
 * 规则只能靠变量名猜（只认 n），于是很多题拿不到 targetN，反算只能退化成
 * 「随机值、规模不变」。这里训练了一个候选排序模型：给每个候选上界打分，
 * 选出真正的「数据规模参数」。
 *
 * 模型：逻辑回归 + 确定性特征哈希（FNV-1a），权重存在 range-weights.json。
 * 训练数据来自洛谷全量 P 题的中英文范围段落，监督信号取「该上界 >= 样例里的实际计数」。
 * 测试集 top-1 准确率 96.0%（zh+en 联合）。
 *
 * 与 Python 训练脚本的对应关系见 tools/range-model/（特征名与哈希必须完全一致，
 * 改动任何一侧都要重新训练，否则权重会错位）。
 */
/**
 * 权重文件路径。
 *
 * 不能用 __dirname：Hydro 的 @hydrooj/register 钩子会把 esbuild 生成的
 * `const __dirname = dirname(__filename)` 整行删掉，运行时它是 undefined。
 * 也不要在模块顶层读文件——一旦抛错，模块整体变成空对象，
 * 调用方只会看到「predictRange is not a function」这种误导性错误。
 * 因此改为惰性加载，并把真实失败原因留在异常里。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

function modelPaths(): string[] {
    const paths: string[] = [];
    // 插件被挂到 /root/.hydro/addons/<name>/，src 就在其下
    paths.push('/root/.hydro/addons/luogu-import/src/range-weights.json');
    paths.push(join(process.cwd(), 'addons/luogu-import/src/range-weights.json'));
    paths.push(join(process.cwd(), 'src/range-weights.json'));
    if (process.env.LUOGU_MODEL_PATH) paths.unshift(process.env.LUOGU_MODEL_PATH);
    return paths;
}

interface RawModel { version: number; dim: number; bias: number; w: Record<string, number> }

let _model: RawModel | null = null;

function loadModel(): RawModel {
    if (_model) return _model;
    const tried: string[] = [];
    for (const p of modelPaths()) {
        try {
            _model = JSON.parse(readFileSync(p, 'utf8')) as RawModel;
            return _model;
        } catch (e) {
            tried.push(`${p}: ${(e as Error)?.message || e}`);
        }
    }
    throw new Error(`range-weights.json 加载失败。尝试过：\n${tried.join('\n')}`);
}

const dimOf = () => loadModel().dim;

/** FNV-1a 32bit，必须与训练脚本 hasher.py 逐位一致 */
function h32(s: string): number {
    let x = 0x811C9DC5;
    const bytes = Buffer.from(s, 'utf8');
    for (let i = 0; i < bytes.length; i++) {
        x ^= bytes[i];
        // x * 16777619，用 Math.imul 保证 32 位
        x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x >>> 0;
}

const STRONG = new Set(['n', 'N', 'len', 'length', 'size', 'm', 'M']);
const WEAK = new Set(['k', 'K', 'q', 'Q', 'cnt', 'tot', 'operations', 'op', 'ops', 'num', 'number', 'T', 't', 'l', 'L']);

const MACROS: Array<[RegExp, string]> = [
    [/\\times(?![a-zA-Z])/g, ' * '],
    [/\\cdot(?![a-zA-Z])/g, ' * '],
    [/\\le(q|qslant)?(?![a-zA-Z])/g, ' <= '],
    [/\\ge(q|qslant)?(?![a-zA-Z])/g, ' >= '],
    [/\\(?:dfrac|frac)(?![a-zA-Z])/g, ' / '],
    [/\\lvert|\\rvert|\\vert/g, ' '],
    [/\\[a-zA-Z]+\*?/g, ' '],
    [/[{}\\]/g, ' '],
];
const CN: Array<[string, string]> = [
    ['不超过', ' <= '], ['不大于', ' <= '], ['至多', ' <= '], ['最多', ' <= '],
    ['不小于', ' >= '], ['至少', ' >= '], ['最少', ' >= '], ['小于等于', ' <= '], ['大于等于', ' >= '],
];
const EN: Array<[RegExp, string]> = [
    [/\bat\s+most\b/gi, ' <= '], [/\bno\s+more\s+than\b/gi, ' <= '], [/\bup\s+to\b/gi, ' <= '],
    [/\bless\s+than\s+or\s+equal\s+to\b/gi, ' <= '], [/\bnot\s+greater\s+than\b/gi, ' <= '],
    [/\bat\s+least\b/gi, ' >= '], [/\bno\s+less\s+than\b/gi, ' >= '],
];
const SYM: Array<[string, string]> = [
    ['≤', ' <= '], ['≥', ' >= '], ['×', ' * '], ['·', ' * '],
    ['＜', ' < '], ['＞', ' > '], ['≦', ' <= '], ['≧', ' >= '],
];

export function normalize(text: string): string {
    let s = String(text || '');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ');
    s = s.replace(/\$/g, ' ');
    // 千分位必须在 MACROS 之前处理，否则 {,} 会被换成空格再也合不回去
    s = s.replace(/\{\s*,\s*\}/g, '');
    for (let i = 0; i < 3; i++) s = s.replace(/(\d)\s*,\s*(\d{3})(?!\d)/g, '$1$2');
    for (const [re, rep] of MACROS) s = s.replace(re, rep);
    for (const [a, b] of CN) s = s.split(a).join(b);
    for (const [a, b] of SYM) s = s.split(a).join(b);
    for (const [re, rep] of EN) s = s.replace(re, rep);
    return s.replace(/[ \t]+/g, ' ');
}

const NUM = String.raw`(?:\d+(?:\.\d+)?\s*(?:\*\s*)?10\s*\^\s*\{?\s*\d+\s*\}?|\d+\s*\^\s*\{?\s*\d+\s*\}?|\d+(?:\.\d+)?)`;
const VAR = String.raw`([A-Za-z][A-Za-z0-9_]{0,15})`;

function magnitude(tok: string): number | null {
    const t = tok.replace(/[\s{}]/g, '');
    let m = /^(\d+(?:\.\d+)?)\*?10\^(\d+)$/.exec(t);
    if (m) return Number(m[1]) * 10 ** Number(m[2]);
    m = /^10\^(\d+)$/.exec(t);
    if (m) return 10 ** Number(m[1]);
    m = /^(\d+(?:\.\d+)?)$/.exec(t);
    if (m) return Number(m[1]);
    return null;
}

function log10b(v: number): number {
    if (!v || v <= 0) return -1;
    return Math.min(12, Math.floor(Math.log10(v)));
}

export interface Bound {
    name: string;
    sign: '<=' | '>=';
    value: number;
    kind: string;
}

export function bounds(text: string): Bound[] {
    const s = normalize(text);
    const out: Bound[] = [];
    const push = (name: string, val: number | null, kind: string, sign: '<=' | '>=' = '<=') => {
        if (val && Number.isFinite(val)) out.push({ name, sign, value: val, kind });
    };
    let m: RegExpExecArray | null;

    const reChain = new RegExp(`${NUM}\\s*(?:<=|<)\\s*${VAR}\\s*(?:<=|<)\\s*(${NUM})`, 'g');
    while ((m = reChain.exec(s)) !== null) push(m[1], magnitude(m[2]), 'chain');

    const reDirect = new RegExp(`${VAR}\\s*(?:<=|<)\\s*(${NUM})`, 'g');
    while ((m = reDirect.exec(s)) !== null) push(m[1], magnitude(m[2]), 'direct');

    const reRev = new RegExp(`(${NUM})\\s*(?:<=|<)\\s*${VAR}`, 'g');
    while ((m = reRev.exec(s)) !== null) push(m[2], magnitude(m[1]), 'reverse', '>=');

    const reGe = new RegExp(`${VAR}\\s*(?:>=|>)\\s*(${NUM})`, 'g');
    while ((m = reGe.exec(s)) !== null) push(m[1], magnitude(m[2]), 'ge', '>=');

    const reRevGe = new RegExp(`(${NUM})\\s*(?:>=|>)\\s*${VAR}`, 'g');
    while ((m = reRevGe.exec(s)) !== null) push(m[2], magnitude(m[1]), 'rev_ge');

    const reList = new RegExp(String.raw`((?:[A-Za-z][A-Za-z0-9_]{0,15}\s*[,，、]\s*)+[A-Za-z][A-Za-z0-9_]{0,15})\s*(?:<=|<)\s*(${NUM})`, 'g');
    while ((m = reList.exec(s)) !== null) {
        const v = magnitude(m[2]);
        if (!v) continue;
        for (const nm of m[1].split(/[,，、]/)) {
            const t = nm.trim();
            if (t) push(t, v, 'list');
        }
    }
    return out;
}

function textBucketKeys(text: string): number[] {
    const s = normalize(text);
    const keys: number[] = [];
    const skel = s.replace(/\d+/g, '#');
    const toks = skel.match(/[A-Za-z]{2,}|[\u4e00-\u9fff]{1,4}|<=|>=/g) || [];
    for (const t of toks) keys.push(h32('w:' + t.toLowerCase()) & (dimOf() - 1));

    const bs = bounds(text);
    const ups = bs.filter((b) => b.sign === '<=');
    const addKey = (k: string) => keys.push(h32(k) & (dimOf() - 1));

    addKey('n_up:' + Math.min(ups.length, 8));
    addKey('n_all:' + Math.min(bs.length, 10));
    if (!bs.length) addKey('no_bounds');

    const cnt = ups.filter((b) => WEAK.has(b.name) || STRONG.has(b.name));
    addKey('has_count:' + (cnt.length ? 1 : 0));
    if (cnt.length) {
        addKey('cnt_min_mag:' + log10b(Math.min(...cnt.map((c) => c.value))));
        addKey('cnt_max_mag:' + log10b(Math.max(...cnt.map((c) => c.value))));
        addKey('cnt_cnt:' + Math.min(cnt.length, 5));
    }
    if (ups.length) {
        const mags = ups.map((b) => log10b(b.value)).sort((a, b) => a - b);
        addKey('up_min_mag:' + mags[0]);
        addKey('up_max_mag:' + mags[mags.length - 1]);
        addKey('up_spread:' + Math.min(9, mags[mags.length - 1] - mags[0]));
    }
    for (const b of ups) {
        addKey('var:' + b.name);
        addKey('kind:' + b.kind);
        addKey(`varmag:${b.name}:${log10b(b.value)}`);
        if (WEAK.has(b.name) || STRONG.has(b.name)) addKey(`countvar:${b.name}:${log10b(b.value)}`);
    }
    if (/(?:不超过|不大于|至多|最多)\s*\d/.test(s)) addKey('cn_phrase');
    if (/\bat\s+most\s+\d/i.test(s)) addKey('en_phrase');
    if (/题目来源|source\b/i.test(s)) addKey('source_note');
    if ((s.match(/\|/g) || []).length >= 4) addKey('table_form');
    return keys;
}

function candidateKeys(textKeys: number[], varName: string, val: number, cands: Array<[string, number]>): number[] {
    const keys = textKeys.slice();
    const addKey = (k: string) => keys.push(h32(k) & (dimOf() - 1));
    addKey('var:' + varName);
    addKey('cls:' + (STRONG.has(varName) ? 'S' : WEAK.has(varName) ? 'W' : 'O'));
    addKey('mag:' + log10b(val));
    const vals = cands.map((c) => c[1]);
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    addKey('pos:' + (val === mn ? 'min' : val === mx ? 'max' : 'mid'));
    addKey('gap:' + Math.min(9, log10b(val) - log10b(mn)));
    addKey('nc:' + Math.min(6, cands.length));
    addKey('digits:' + Math.min(9, String(Math.trunc(val)).length));
    return keys;
}

function score(keys: number[]): number {
    const m = loadModel();
    let z = m.bias;
    for (const k of keys) {
        const w = m.w[String(k)];
        if (w !== undefined) z += w;
    }
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

export interface RangePrediction {
    /** 选出的数据规模上界；null 表示题面没写范围 */
    targetN: number | null;
    confidence: number;
    variable: string | null;
    /** 该变量的所有上界（升序），便于诊断 */
    candidates: number[];
}

/**
 * 从范围文本预测「数据规模上界」。
 *
 * 同名变量的多个上界会先取最大值再用——题面常分 30%/100% 两档，
 * 要的是满档；直接让模型选会经常选中部分分档（实测 2.1% 错例）。
 */
export function predictRange(text: string, maxLimit = 5_000_000): RangePrediction {
    const raw = bounds(text);
    const byVar = new Map<string, number>();
    for (const b of raw) {
        if (b.sign !== '<=') continue;
        if (!(b.value >= 1 && b.value <= maxLimit)) continue;
        byVar.set(b.name, Math.max(byVar.get(b.name) || 0, b.value));
    }
    if (!byVar.size) return { targetN: null, confidence: 0, variable: null, candidates: [] };

    const entries = [...byVar.entries()];
    const cands = entries.map(([n, v]) => [n, v] as [string, number]);
    const textKeys = textBucketKeys(text);
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < cands.length; i++) {
        const s = score(candidateKeys(textKeys, cands[i][0], cands[i][1], cands));
        if (s > bestScore) {
            bestScore = s;
            bestIdx = i;
        }
    }
    return {
        targetN: Math.round(cands[bestIdx][1]),
        confidence: bestScore,
        variable: cands[bestIdx][0],
        candidates: cands.map((c) => c[1]).sort((a, b) => a - b),
    };
}
