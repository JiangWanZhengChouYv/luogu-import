import crypto from 'crypto';
import {
    Logger, ProblemModel, yaml,
} from 'hydrooj';
import {
    fetchProblem, fetchProblemList, fetchTags, LuoguProblem, LuoguStatement,
} from './client';

const logger = new Logger('luogu-import');

/** 洛谷难度 0-7 映射到 Hydro difficulty 0-10 */
const DIFFICULTY_MAP = [0, 1, 2, 3, 4, 6, 8, 10];

/** Hydro 的 locale key（locales/*.yaml）：zh / en / ko / zh_TW */
const LANG_ORDER = ['zh', 'zh_TW', 'en', 'ko'];

export type SampleMode = 'first' | 'all' | 'none';

export interface ImportOptions {
    domainId: string;
    owner: number;
    hidden: boolean;
    overwrite: boolean;
    samples: SampleMode;
}

export interface LoggedItem {
    /** 落到 Hydro 的题号（可能经过合法性映射） */
    pid: string;
    /** 洛谷原始题号 */
    sourcePid: string;
    status: 'ok' | 'skipped' | 'failed';
    docId?: number;
    message?: string;
    languages?: string[];
}

/** 洛谷 locale -> Hydro locale（题目页 ?lang= 用后者） */
export function toHydroLang(locale: string): string {
    const l = String(locale || '').trim();
    if (/^zh[-_]?(CN|Hans)$/i.test(l) || /^zh$/i.test(l)) return 'zh';
    if (/^zh[-_]?(TW|HK|Hant)/i.test(l)) return 'zh_TW';
    if (/^en/i.test(l)) return 'en';
    if (/^ko/i.test(l)) return 'ko';
    return l.replace(/-/g, '_');
}

/**
 * Hydro Types.ProblemId = /^(?:[a-z0-9]{1,10}-)?[a-z0-9]+$/i，不允许下划线。
 * AT 库题号如 AT1202Contest_a 必须映射后才能被 /p/{pid} 访问；
 * 抓取题面仍用洛谷原始题号。
 */
export function toHydroPid(sourcePid: string): string {
    const s = String(sourcePid || '').trim();
    if (/^(?:[a-z0-9]{1,10}-)?[a-z0-9]+$/i.test(s)) return s;
    const base = s.replace(/[^A-Za-z0-9]/g, '');
    const hash = crypto.createHash('sha256').update(s).digest('hex').slice(0, 6);
    return `${base || 'LG'}${hash}`;
}

/** 只把「纯前缀+数字」的手动输入纠正成大写，避免破坏 AT 这类大小写敏感题号 */
export function normalizePid(raw: string): string {
    const s = String(raw || '').trim();
    const m = s.match(/^([A-Za-z]+)(\d+)$/);
    if (m) return m[1].toUpperCase() + m[2];
    return s;
}

export function isValidPid(pid: string) {
    return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(pid);
}

/** 解析 "P1001,P1002 P1003" 或换行分隔 */
export function parsePidList(raw: string): string[] {
    return String(raw || '')
        .split(/[\s,，;；]+/)
        .map(normalizePid)
        .filter(Boolean);
}

/** 解析 "P1000-P1010" 或 "P1000~P1010" */
export function parsePidRange(raw: string): string[] {
    const m = String(raw || '').trim().match(/^([A-Za-z]+)(\d+)\s*[-~—]\s*(?:([A-Za-z]+))?(\d+)$/);
    if (!m) throw new Error('题号区间格式错误，应形如 P1000-P1010');
    const prefix = m[1].toUpperCase();
    const from = Number(m[2]);
    const toPrefix = (m[3] || m[1]).toUpperCase();
    const to = Number(m[4]);
    if (toPrefix !== prefix) throw new Error('区间两端题号前缀必须一致');
    if (to < from) throw new Error('区间结束题号不能小于开始题号');
    if (to - from > 1000) throw new Error('单次区间最多 1000 题，请分批导入');
    const result: string[] = [];
    for (let i = from; i <= to; i++) result.push(`${prefix}${i}`);
    return result;
}

function mdFence(text: string) {
    return text.includes('```') ? '````' : '```';
}

/** 单个语言版本的 Markdown 题面；样例与来源在各语言里共用 */
function buildStatementMarkdown(p: LuoguProblem, c: LuoguStatement, submitPid?: string): string {
    const parts: string[] = [];
    if (c.background.trim()) parts.push(`## 题目背景\n\n${c.background.trim()}`);
    if (c.description.trim()) parts.push(`## 题目描述\n\n${c.description.trim()}`);
    if (c.formatI.trim()) parts.push(`## 输入格式\n\n${c.formatI.trim()}`);
    if (c.formatO.trim()) parts.push(`## 输出格式\n\n${c.formatO.trim()}`);
    p.samples.forEach(([input, output], idx) => {
        const fence = mdFence(input + output);
        const i = input.endsWith('\n') ? input : `${input}\n`;
        const o = output.endsWith('\n') ? output : `${output}\n`;
        parts.push([
            `## 样例 #${idx + 1}`,
            '',
            `### 样例输入 #${idx + 1}`,
            '',
            `${fence}`,
            i.trimEnd(),
            `${fence}`,
            '',
            `### 样例输出 #${idx + 1}`,
            '',
            `${fence}`,
            o.trimEnd(),
            `${fence}`,
        ].join('\n'));
    });
    if (c.hint.trim()) parts.push(`## 提示\n\n${c.hint.trim()}`);
    const submitLink = submitPid || p.pid;
    parts.push(`---\n\n来源：[洛谷 ${p.pid}](https://www.luogu.com.cn/problem/${p.pid})`
        + ` · [提交到 Luogu](/luogu/submit/${encodeURIComponent(submitLink)})`);
    return parts.join('\n\n');
}

/**
 * 洛谷 data.translations -> Hydro 官方多语言题面格式。
 * ProblemModel.add/edit 收到 JSON 字符串对象 {lang: markdown} 时，会由
 * normalizeStatements 写入 problem.statement（name=`<lang>.md`, lang=`<lang>`），
 * 题目页自动出现语言切换（?lang=zh / ?lang=en）。
 */
export function buildStatementMap(p: LuoguProblem, submitPid?: string): Record<string, string> {
    const collected: Record<string, string[]> = {};
    const entries = Object.entries(p.statements || {});
    if (!entries.length) {
        entries.push(['zh-CN', {
            name: p.name, background: '', description: '',
            formatI: '', formatO: '', hint: '', locale: 'zh-CN',
        } as LuoguStatement]);
    }
    for (const [locale, statement] of entries) {
        const lang = toHydroLang(locale) || 'zh';
        (collected[lang] ||= []).push(buildStatementMarkdown(p, statement, submitPid));
    }
    const langs = Object.keys(collected).sort((a, b) => {
        const ia = LANG_ORDER.indexOf(a);
        const ib = LANG_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    const out: Record<string, string> = {};
    for (const lang of langs) out[lang] = collected[lang].join('\n\n---\n\n');
    return out;
}

export function buildContent(p: LuoguProblem, submitPid?: string): string {
    return JSON.stringify(buildStatementMap(p, submitPid));
}

/** 由 index.ts 注入：导入成功后把来源标记写进 luogu.problems */
type SourceMarker = (domainId: string, hydroPid: string, sourcePid: string, source: string) => Promise<void> | void;
let markSource: SourceMarker | null = null;

export function setSourceMarker(fn: SourceMarker) {
    markSource = fn;
}

let tagMapCache: { at: number; map: Map<number, string> } | null = null;

async function tagNames(ids: number[]): Promise<string[]> {
    if (!ids.length) return [];
    try {
        if (!tagMapCache || Date.now() - tagMapCache.at > 3600_000) {
            const tags = await fetchTags();
            tagMapCache = { at: Date.now(), map: new Map(tags.map((t) => [t.id, t.name])) };
        }
        return ids.map((id) => tagMapCache!.map.get(id)).filter(Boolean) as string[];
    } catch (e) {
        logger.warn('获取洛谷标签失败: %s', e.message);
        return [];
    }
}

/**
 * 导入单题。先查 Hydro 是否已有该题（不请求洛谷），这是断点续跑/重复运行
 * 不重复抓题面的关键。pidRaw 是洛谷原始题号。
 */
export async function importProblem(pidRaw: string, opts: ImportOptions): Promise<LoggedItem> {
    const sourcePid = normalizePid(pidRaw);
    if (!isValidPid(sourcePid)) return { pid: sourcePid, sourcePid, status: 'failed', message: '题号格式不正确' };
    const pid = toHydroPid(sourcePid);
    const existing = await ProblemModel.get(opts.domainId, pid);
    if (existing && !opts.overwrite) {
        if (markSource) await markSource(opts.domainId, pid, sourcePid, '');
        return { pid, sourcePid, status: 'skipped', docId: existing.docId, message: '题目已存在' };
    }
    const data = await fetchProblem(sourcePid);
    const tags = await tagNames(data.tags);
    const statementMap = buildStatementMap(data, pid);
    const content = JSON.stringify(statementMap);
    const difficulty = DIFFICULTY_MAP[data.difficulty] ?? 0;
    let docId: number;
    if (existing) {
        docId = existing.docId;
        await ProblemModel.edit(opts.domainId, docId, {
            title: data.name,
            content,
            tag: tags,
            difficulty,
            hidden: opts.hidden,
        });
    } else {
        docId = await ProblemModel.add(
            opts.domainId, pid, data.name, content, opts.owner, tags,
            { difficulty, hidden: opts.hidden },
        );
    }
    if (opts.samples !== 'none') {
        const samples = opts.samples === 'all' ? data.samples : data.samples.slice(0, 1);
        // 覆盖导入时清掉旧的数字测试点：反算会写 1..10 的 .in/.out，若不清，
        // 官方样例只有 1 组时就会留下 2..10 这些空 .out 的残缺组，评测直接判错。
        if (existing) {
            const oldNumeric = ((existing.data || []) as any[])
                .map((f) => String(f.name || ''))
                .filter((n) => /^\d+\.(in|out)$/.test(n) || n === 'luogu_gen.cpp' || n === 'luogu_std.cpp');
            for (const name of oldNumeric) {
                await ProblemModel.delTestdata(opts.domainId, docId, name);
            }
        }
        for (let i = 0; i < samples.length; i++) {
            await ProblemModel.addTestdata(opts.domainId, docId, `${i + 1}.in`, Buffer.from(samples[i][0]));
            await ProblemModel.addTestdata(opts.domainId, docId, `${i + 1}.out`, Buffer.from(samples[i][1]));
        }
        if (samples.length) {
            const config = {
                time: `${data.limits.time}ms`,
                memory: `${Math.max(1, Math.round(data.limits.memory / 1024))}m`,
            };
            await ProblemModel.addTestdata(
                opts.domainId, docId, 'config.yaml', Buffer.from(yaml.dump(config)),
            );
        }
    }
    if (markSource) await markSource(opts.domainId, pid, sourcePid, data.type || '');
    return { pid, sourcePid, status: 'ok', docId, languages: Object.keys(statementMap) };
}

export interface JobSpec {
    pids?: string[];
    range?: string;
    list?: {
        type?: string;
        keyword?: string;
        difficulty?: number[];
        tag?: number[];
        pages?: number;
    };
}

/** 把任务描述解析成题号列表（列表模式会请求洛谷，仅用于手动导入） */
export async function resolvePids(spec: JobSpec): Promise<string[]> {
    const all: string[] = [];
    if (spec.pids && spec.pids.length) all.push(...spec.pids.map(normalizePid));
    if (spec.range) all.push(...parsePidRange(spec.range));
    if (spec.list) {
        const pages = Math.max(1, Math.min(20, Number(spec.list.pages) || 1));
        for (let page = 1; page <= pages; page++) {
            const res = await fetchProblemList({
                page,
                type: spec.list.type,
                keyword: spec.list.keyword,
                difficulty: spec.list.difficulty,
                tag: spec.list.tag,
            });
            for (const item of res.result) all.push(normalizePid(item.pid));
            if (res.result.length < res.perPage) break;
        }
    }
    return Array.from(new Set(all.filter(Boolean)));
}
