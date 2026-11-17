/**
 * 洛谷远端提交适配层：语言映射、评测状态映射、逐测试点结果整理、题目来源标记。
 *
 * 不改 Hydro 的 record / 判题流程，结果只在插件自有页面展示。
 */
import { Logger } from 'hydrooj';

const logger = new Logger('luogu-import/submit');

/** Hydro codeLang -> 洛谷 { lang, enableO2 }。O2 不是独立 lang id。 */
export interface LangMapping {
    lang: number;
    enableO2: boolean;
    label: string;
}

export const LANG_MAP: Record<string, LangMapping> = {
    cc: { lang: 11, enableO2: false, label: 'C++14' },
    'cc.cc98': { lang: 3, enableO2: false, label: 'C++98' },
    'cc.cc98o2': { lang: 3, enableO2: true, label: 'C++98(O2)' },
    'cc.cc11': { lang: 4, enableO2: false, label: 'C++11' },
    'cc.cc11o2': { lang: 4, enableO2: true, label: 'C++11(O2)' },
    'cc.cc14': { lang: 11, enableO2: false, label: 'C++14' },
    'cc.cc14o2': { lang: 11, enableO2: true, label: 'C++14(O2)' },
    'cc.cc17': { lang: 12, enableO2: false, label: 'C++17' },
    'cc.cc17o2': { lang: 12, enableO2: true, label: 'C++17(O2)' },
    'cc.cc20': { lang: 27, enableO2: false, label: 'C++20' },
    'cc.cc20o2': { lang: 27, enableO2: true, label: 'C++20(O2)' },
    'cc.cc23': { lang: 34, enableO2: false, label: 'C++23' },
    'cc.cc23o2': { lang: 34, enableO2: true, label: 'C++23(O2)' },
};

export function resolveLang(codeLang: string): LangMapping | null {
    const key = String(codeLang || '').trim();
    if (LANG_MAP[key]) return LANG_MAP[key];
    // 自定义语言 id 里带版本/O2 关键字时宽松兜底
    const lower = key.toLowerCase();
    const version = /23/.test(lower) ? 34 : /20/.test(lower) ? 27 : /17/.test(lower) ? 12
        : /11/.test(lower) ? 4 : /98/.test(lower) ? 3 : 11;
    if (/^cc\./.test(lower) || lower === 'cc') {
        return { lang: version, enableO2: /o2/.test(lower), label: key };
    }
    return null;
}

export const STATUS_TEXT: Record<number, string> = {
    [-1]: '未显示 (Unshown)',
    0: '等待中 (Waiting)',
    1: '评测中 (Judging)',
    2: '编译错误 (CE)',
    3: '输出超限 (OLE)',
    4: '内存超限 (MLE)',
    5: '时间超限 (TLE)',
    6: '答案错误 (WA)',
    7: '运行错误 (RE)',
    11: '未知错误 (UKE)',
    12: '通过 (AC)',
    14: '未通过 (Unaccepted)',
    21: 'Hack 成功',
    22: 'Hack 失败',
    23: 'Hack 跳过',
};

/** 除 0 / 1 外均为终态 */
const TERMINAL_CODES = new Set([-1, 2, 3, 4, 5, 6, 7, 11, 12, 14, 21, 22, 23]);

export function statusText(code: any): string {
    const n = Number(code);
    if (!Number.isFinite(n)) return '未知';
    return STATUS_TEXT[n] || `状态码 ${n}（未知）`;
}

export function isTerminal(code: any): boolean {
    const n = Number(code);
    return Number.isFinite(n) && TERMINAL_CODES.has(n);
}

/** 洛谷来源前缀（旧题兜底用；AT 映射后的 pid 仍以 AT 开头） */
const SOURCE_PREFIXES = ['P', 'B', 'CF', 'SP', 'AT', 'UVA'];

export function looksLikeLuoguPid(pid: string): boolean {
    const s = String(pid || '').trim();
    return SOURCE_PREFIXES.some((p) => new RegExp(`^${p}[A-Za-z0-9_-]+$`, 'i').test(s));
}

/** 题目来源标记集合：新导入的题落一条，识别时标记优先、前缀兜底 */
let markerColl: any = null;

/**
 * 标记的同步内存副本。
 * 题目页的侧栏注入发生在 handler/create 阶段，那里没法 await 数据库，
 * 所以把已标记的 pid 预加载进 Set，渲染时同步判断。
 * 这样「本站自带的 P1000」不会被误判成洛谷题（前缀判断会误判）。
 */
const markedCache = new Set<string>();
let markedCacheReady = false;

export function initSourceMarkers(collection: any) {
    markerColl = collection;
    // 启动时预加载，失败也不影响主流程（只是侧栏按钮不显示）
    collection.find({}).project({ domainId: 1, hydroPid: 1 }).toArray()
        .then((docs: any[]) => {
            for (const d of docs) {
                if (d?.domainId && d?.hydroPid) markedCache.add(markerKey(String(d.domainId), String(d.hydroPid)));
            }
            markedCacheReady = true;
            logger.info('loaded %d luogu problem markers into memory', markedCache.size);
        })
        .catch((e: Error) => { logger.warn('preload markers failed: %s', e.message); });
}

/** 同步判断：这个 pid 是不是本插件导入过的题 */
export function isLuoguProblemSync(domainId: string, pid: string, allowPrefixFallback = false): boolean {
    if (markedCache.has(markerKey(domainId, pid))) return true;
    // 仅在「一题都没标记」且显式允许时才退回前缀判断，
    // 避免把 Hydro 自带的 P1000 之类误认成洛谷题。
    if (allowPrefixFallback && markedCacheReady && markedCache.size === 0) return looksLikeLuoguPid(pid);
    return false;
}

export function markerKey(domainId: string, pid: string) {
    return `${domainId}:${pid}`;
}

export async function markLuoguProblem(domainId: string, hydroPid: string, sourcePid: string, source: string) {
    if (!markerColl) return;
    try {
        await markerColl.updateOne(
            { _id: markerKey(domainId, hydroPid) },
            {
                $set: {
                    domainId, hydroPid, sourcePid, source: source || '',
                    updatedAt: Date.now(),
                },
            },
            { upsert: true },
        );
        markedCache.add(markerKey(domainId, hydroPid));
    } catch (e) {
        logger.warn('mark source failed for %s: %s', hydroPid, e.message);
    }
}

/** 洛谷原始题号：AT 等题在 Hydro 里经过映射，提交时必须换回原题号 */
export async function getSourcePid(domainId: string, hydroPid: string): Promise<string> {
    if (markerColl) {
        const doc = await markerColl.findOne({ _id: markerKey(domainId, hydroPid) }).catch(() => null);
        if (doc?.sourcePid) return String(doc.sourcePid);
    }
    return hydroPid;
}

/**
 * 批量取出「本插件确实导入过」的 pid 集合。
 * 删题等破坏性操作必须用它，不能用 looksLikeLuoguPid —
 * Hydro 自带的演示题 P1000 形状也是洛谷题号，只看形状会误删本站原有题目。
 */
export async function listMarkedPids(domainId: string): Promise<Set<string>> {
    const out = new Set<string>();
    if (!markerColl) return out;
    try {
        const docs = await markerColl.find({ domainId }).project({ hydroPid: 1 }).toArray();
        for (const d of docs) if (d?.hydroPid) out.add(String(d.hydroPid));
    } catch (e) {
        logger.warn('listMarkedPids failed: %s', (e as Error).message);
    }
    return out;
}

/**
 * 异步判断（提交入口用）：以标记集合为准。
 * 前缀只在「一题都没标记」且 allowPrefixFallback 时兜底，
 * 否则本站自带题（如 Hydro 演示题 P1000）会被允许提交到洛谷。
 */
export async function isLuoguProblem(domainId: string, pid: string, allowPrefixFallback = false): Promise<boolean> {
    if (markedCache.has(markerKey(domainId, pid))) return true;
    if (markerColl) {
        const doc = await markerColl.findOne({ _id: markerKey(domainId, pid) }).catch(() => null);
        if (doc) { markedCache.add(markerKey(domainId, pid)); return true; }
    }
    if (allowPrefixFallback && markedCache.size === 0) return looksLikeLuoguPid(pid);
    return false;
}

function asArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
        return Object.entries(value)
            .sort((a: any, b: any) => (Number(a[0]) || 0) - (Number(b[0]) || 0))
            .map(([id, v]: any) => ({ id: Number(id), ...(v && typeof v === 'object' ? v : {}) }));
    }
    return [];
}

function num(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function compileErrorOf(record: any): string {
    const detail = record?.detail || {};
    const candidates = [
        detail?.compileResult?.message,
        record?.compileResult?.message,
        detail?.compileError,
        record?.compileError,
        record?.compileErrorMessage,
    ];
    return candidates.find((v) => typeof v === 'string' && v.trim()) || '';
}

/** 把洛谷 data.record 整理成前端可直接渲染的结构 */
export function formatRecord(rid: string, record: any) {
    const status = num(record?.status);
    const detail = record?.detail;
    const judge = detail?.judgeResult || record?.judgeResult;
    const rawSubtasks = asArray(judge?.subtasks || record?.subtasks);
    const subtasks = rawSubtasks.map((s: any, si: number) => ({
        id: num(s?.id) ?? si,
        status: num(s?.status),
        statusText: statusText(s?.status),
        score: num(s?.score),
        timeMs: num(s?.time),
        memoryKb: num(s?.memory),
        testCases: asArray(s?.testCases).map((c: any, ci: number) => ({
            id: num(c?.id) ?? ci,
            status: num(c?.status),
            statusText: statusText(c?.status),
            score: num(c?.score),
            timeMs: num(c?.time),
            memoryKb: num(c?.memory),
            description: typeof c?.description === 'string' ? c.description : '',
        })),
    }));
    return {
        rid,
        status,
        statusText: statusText(status),
        terminal: isTerminal(status),
        score: num(record?.score),
        timeMs: num(record?.time),
        memoryKb: num(record?.memory),
        compileError: compileErrorOf(record),
        detailAvailable: !!detail,
        subtasks,
        luoguUrl: `https://www.luogu.com.cn/record/${rid}`,
    };
}
