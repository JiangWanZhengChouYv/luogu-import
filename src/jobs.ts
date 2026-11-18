/**
 * 洛谷导入任务：Mongo 持久化 + 断点续跑 + 暂停/继续/取消 + 重启恢复。
 *
 * 任务文档（luogu.job）本身即进度：cursor 指向下一个要处理的题目，
 * 每处理一题就落盘一次；崩溃/重启后从 cursor 继续，已落库的题会被
 * importProblem() 直接跳过（不会重复请求题面）。
 */
import { Logger, nanoid } from 'hydrooj';
import { fetchProblemList, getDelay, probeProblemExists, setDelay } from './client';
import {
    importProblem, normalizePid, resolvePids, ImportOptions, JobSpec,
} from './importer';

const logger = new Logger('luogu-import/jobs');

const RUNNER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const STALE_MS = 120_000;
const MAX_LOGS = 400;

export type JobStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'error' | 'interrupted';
export type JobMode = 'manual' | 'full';

export interface JobOptions extends ImportOptions {
    sources: string[];
    /** 0 = 不设上限（用户已允许长时间跑） */
    maxProblems: number;
    delayMs: number;
    requireLogin: boolean;
}

export interface JobCursor {
    sourceIndex: number;
    page: number;
    pidIndex: number;
    processed: number;
    /** 题号补漏阶段：当前探测到的题号（0 = 尚未进入补漏阶段） */
    probeIndex?: number;
}

export interface JobEstimate {
    sources: Record<string, number>;
    problems: number;
    pages: number;
    mb: number;
    hours: number;
    seconds: number;
    delayMs: number;
}

export interface JobDoc {
    _id: string;
    mode: JobMode;
    status: JobStatus;
    spec?: JobSpec;
    pids?: string[];
    sources: string[];
    cursor: JobCursor;
    counts: {
        total: number; done: number; ok: number; skipped: number; failed: number;
        probed?: number; recovered?: number;
    };
    options: JobOptions;
    estimate?: JobEstimate;
    logs: string[];
    owner: number;
    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    finishedAt?: number;
    heartbeat: number;
    runner?: string;
    error?: string;
}

let coll: any = null;
const active = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function initJobs(collection: any) {
    coll = collection;
}

function db() {
    if (!coll) throw new Error('任务存储未初始化（数据库不可用）');
    return coll;
}

function stamp(message: string) {
    return `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
}

export interface CreateJobInput {
    mode: JobMode;
    spec?: JobSpec;
    pids?: string[];
    sources?: string[];
    options: JobOptions;
    estimate?: JobEstimate;
    owner: number;
    /** 小样验证：只跑前 N 页，不改变全量实现 */
    maxPages?: number;
}

export async function createJob(input: CreateJobInput): Promise<JobDoc> {
    const id = `luogu-${Date.now()}-${nanoid(6)}`;
    const now = Date.now();
    const total = input.mode === 'manual'
        ? (input.pids?.length || 0)
        : (input.estimate?.problems || 0);
    const doc: JobDoc = {
        _id: id,
        mode: input.mode,
        status: 'queued',
        spec: input.spec,
        pids: input.pids,
        sources: input.sources || [],
        cursor: { sourceIndex: 0, page: 1, pidIndex: 0, processed: 0 },
        counts: { total, done: 0, ok: 0, skipped: 0, failed: 0 },
        options: input.options,
        estimate: input.estimate,
        logs: [stamp(input.mode === 'full'
            ? `全量任务已创建：来源 ${(input.sources || []).join('/')}，预计 ${total} 题`
            : `导入任务已创建：${total} 题`)],
        owner: input.owner,
        createdAt: now,
        updatedAt: now,
        heartbeat: now,
    };
    if (input.maxPages) (doc as any).maxPages = input.maxPages;
    await db().insertOne(doc);
    return doc;
}

export async function getJobDoc(id: string): Promise<JobDoc | null> {
    return db().findOne({ _id: id });
}

export async function listJobs(limit = 20): Promise<any[]> {
    const docs = await db().find({}).sort({ createdAt: -1 }).limit(limit).toArray();
    return docs.map((d: JobDoc) => ({
        id: d._id,
        mode: d.mode,
        status: d.status,
        sources: d.sources,
        cursor: d.cursor,
        counts: d.counts,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        finishedAt: d.finishedAt,
        error: d.error,
    }));
}

async function log(id: string, message: string, extra: Record<string, any> = {}) {
    await db().updateOne(
        { _id: id },
        {
            $set: { updatedAt: Date.now(), heartbeat: Date.now(), ...extra },
            $push: { logs: { $each: [stamp(message)], $slice: -MAX_LOGS } },
        },
    );
}

/** 从各来源列表首页取 count，估算题量 / 磁盘 / 耗时 */
export async function estimate(sources: string[], samples: string, delayMs: number): Promise<JobEstimate> {
    const counts: Record<string, number> = {};
    for (const type of sources) {
        try {
            const res = await fetchProblemList({ type, page: 1 });
            counts[type] = res.count;
        } catch (e) {
            counts[type] = 0;
            logger.warn('estimate failed for %s: %s', type, e.message);
        }
    }
    const problems = Object.values(counts).reduce((a, b) => a + b, 0);
    const pages = Object.values(counts).reduce((a, c) => a + Math.ceil(c / 50), 0);
    const kbPerProblem = samples === 'none' ? 5 : samples === 'all' ? 12 : 8;
    const seconds = Math.round((problems + pages) * delayMs / 1000);
    return {
        sources: counts,
        problems,
        pages,
        mb: Math.max(1, Math.round(problems * kbPerProblem / 1024)),
        hours: Math.round(seconds / 360) / 10,
        seconds,
        delayMs,
    };
}

async function control(id: string): Promise<'continue' | 'pause' | 'cancel'> {
    const doc = await db().findOne({ _id: id }, { projection: { status: 1 } });
    if (!doc) return 'cancel';
    if (doc.status === 'cancelled') return 'cancel';
    if (doc.status === 'paused') return 'pause';
    if (doc.status !== 'running') return 'cancel';
    return 'continue';
}

/**
 * 拉列表页并做健壮性探测：洛谷偶尔返回空壳（result 为空但 count>0），
 * 直接当作末页会静默漏掉一大批题。空壳页重试 3 次，仍空才返回。
 */
async function fetchListRobust(
    type: string, page: number, id: string,
): Promise<Awaited<ReturnType<typeof fetchProblemList>>> {
    let last: Awaited<ReturnType<typeof fetchProblemList>> | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        last = await fetchProblemList({ type, page });
        const emptyShell = last.count > 0 && last.result.length === 0;
        if (!emptyShell) return last;
        await log(id, `⚠️ 列表 ${type} 第 ${page} 页返回空壳（count=${last.count}），第 ${attempt}/3 次重试`);
        await sleep(1500 * attempt);
    }
    return last!;
}

/** 题号补漏：对列表里缺失的题号用 HEAD 探测，存在的补抓 */
async function probeGaps(
    id: string, source: string, seen: Set<string>, doc: JobDoc, cursor: JobCursor,
    check: () => Promise<string>, onPid: (pid: string) => Promise<void>,
): Promise<{ probed: number; found: number }> {
    const prefix = source.toUpperCase();
    // 题号可能带后缀：CF2021E3（年份+赛题）、CF177E2、AT1202Contest_a、UVA123 …
    // 直接 Number(slice(prefix)) 会把 CF2021E3 算成 2021000，探测上限瞬间变成 200 万，
    // 按 1200ms 限速要跑 28 天（实测卡在这里 18.5 小时）。只取开头的连续数字段。
    const nums = [...seen]
        .filter((p) => p.startsWith(prefix))
        .map((p) => {
            const m = /^(\d+)/.exec(p.slice(prefix.length));
            return m ? Number(m[1]) : NaN;
        })
        .filter((n) => Number.isFinite(n) && n > 0);
    if (!nums.length) return { probed: 0, found: 0 };
    const max = Math.max(...nums);
    // 兜底：探测上限不超过「已见题号数量」的 5 倍，避免任何解析异常把任务拖成天文数字。
    const cap = Math.max(1000, Math.ceil(seen.size * 5));
    const upper = Math.min(max, cap);
    if (upper < max) {
        await log(id, `🔍 ${prefix} 缺口探测上限由 P${max} 收紧到 P${upper}（防止异常题号导致超长探测）`);
    }
    let probed = 0;
    let found = 0;
    const from = Math.max(1, cursor.probeIndex || 1);
    if (from > 1) await log(id, `🔍 ${prefix} 库缺口探测从断点 P${from} 继续`);
    else await log(id, `🔍 ${prefix} 库缺口探测：已知最大题号 P${max}，开始核对缺失题号`);
    for (let n = from; n <= upper; n++) {
        const state = await check();
        if (state !== 'continue') break;
        const pid = `${prefix}${n}`;
        if (seen.has(pid)) continue; // 列表里已有的跳过，不浪费请求
        probed += 1;
        const exists = await probeProblemExists(pid);
        if (exists) {
            found += 1;
            cursor.sourceIndex = doc.sources.indexOf(source);
            cursor.probeIndex = n;
            await db().updateOne({ _id: id }, {
                $set: { cursor: { ...cursor }, heartbeat: Date.now(), updatedAt: Date.now() },
            });
            await onPid(pid);
            await log(id, `🔎 补漏发现 ${pid}（列表未收录），已加入导入`);
        }
    }
    await log(id, `🔍 ${prefix} 库缺口探测完成：探测 ${probed} 个空号，补到 ${found} 题`);
    cursor.probeIndex = 0;
    return { probed, found };
}

async function processOne(id: string, sourcePid: string, doc: JobDoc, cursor: JobCursor) {
    let status: 'ok' | 'skipped' | 'failed' = 'failed';
    let line = '';
    try {
        const item = await importProblem(sourcePid, doc.options);
        status = item.status;
        if (item.status === 'ok') {
            const langs = (item.languages || []).join('/') || 'zh';
            line = `✅ ${sourcePid}${item.pid !== sourcePid ? ` → ${item.pid}` : ''} 导入成功 (docId=${item.docId}, 题面语言=${langs})`;
        } else if (item.status === 'skipped') {
            line = `⏭️ ${sourcePid} 已存在，跳过（未请求题面）`;
        } else {
            line = `❌ ${sourcePid} 失败：${item.message || '未知错误'}`;
        }
    } catch (e) {
        line = `❌ ${sourcePid} 失败：${e?.message || e}`;
    }
    cursor.processed += 1;
    await db().updateOne(
        { _id: id },
        {
            $inc: { 'counts.done': 1, [`counts.${status}`]: 1 },
            $set: { cursor: { ...cursor }, heartbeat: Date.now(), updatedAt: Date.now() },
            $push: { logs: { $each: [stamp(line)], $slice: -MAX_LOGS } },
        },
    );
    if (status === 'failed') logger.warn('%s', line);
}

/** 抢锁后串行执行；返回时任务已终止（done / error / paused / cancelled） */
export async function runJob(id: string): Promise<void> {
    // 「暂停 → 继续」时旧 runner 可能尚未退出，等它收尾再抢锁
    if (active.has(id)) {
        for (let i = 0; i < 20 && active.has(id); i++) await sleep(500);
        if (active.has(id)) return;
    }
    const now = Date.now();
    const claimed = await db().findOneAndUpdate(
        {
            _id: id,
            $or: [
                { status: 'queued' },
                { status: 'running', heartbeat: { $lt: now - STALE_MS } },
                { status: 'interrupted' },
            ],
        },
        { $set: { status: 'running', runner: RUNNER_ID, heartbeat: now, startedAt: now } },
        { returnDocument: 'after' },
    );
    // 兼容 mongodb driver 的 ModifyResult / 直接返回文档两种形态
    const doc: JobDoc | null = claimed?.value || (claimed?._id ? claimed : null);
    if (!doc) return;
    active.add(id);
    let finalStatus: JobStatus = 'done';
    let errorMessage = '';
    try {
        setDelay(doc.options.delayMs || getDelay());
        await log(id, `任务开始（runner=${RUNNER_ID}，限速 ${getDelay()}ms/请求）`);
        const cursor: JobCursor = { ...doc.cursor };
        // 每题都读一次状态：暂停/取消最多延迟一题生效
        const check = () => control(id);

        if (doc.mode === 'manual') {
            const pids = doc.pids?.length ? doc.pids : await resolvePids(doc.spec || {});
            if (!doc.pids?.length) {
                await db().updateOne({ _id: id }, {
                    $set: { pids, 'counts.total': pids.length, updatedAt: Date.now() },
                });
            }
            for (let i = cursor.processed; i < pids.length; i++) {
                const state = await check();
                if (state !== 'continue') { finalStatus = state === 'pause' ? 'paused' : 'cancelled'; break; }
                cursor.pidIndex = i;
                await processOne(id, normalizePid(pids[i]), doc, cursor);
            }
        } else {
            const sources = doc.sources.length ? doc.sources : ['P'];
            const maxPages = (doc as any).maxPages || 0;
            outer: for (let si = cursor.sourceIndex; si < sources.length; si++) {
                const source = sources[si];
                let page = si === cursor.sourceIndex ? Math.max(1, cursor.page) : 1;
                let pagesForSource = 0;
                const seen = new Set<string>(); // 本来源列表已收录的题号，供补漏排除
                while (true) {
                    const state = await check();
                    if (state !== 'continue') { finalStatus = state === 'pause' ? 'paused' : 'cancelled'; break outer; }
                    let list: Awaited<ReturnType<typeof fetchProblemList>>;
                    try {
                        list = await fetchListRobust(source, page, id);
                    } catch (e) {
                        errorMessage = `列表 ${source} 第 ${page} 页抓取失败：${e?.message || e}`;
                        await log(id, `❌ ${errorMessage}（断点已保留，点「继续」可从本页重试）`);
                        finalStatus = 'error';
                        break outer;
                    }
                    pagesForSource += 1;
                    if (!list.result.length) break;
                    const startIdx = (si === cursor.sourceIndex && page === cursor.page) ? cursor.pidIndex : 0;
                    for (let i = startIdx; i < list.result.length; i++) {
                        const state2 = await check();
                        if (state2 !== 'continue') { finalStatus = state2 === 'pause' ? 'paused' : 'cancelled'; break outer; }
                        if (doc.options.maxProblems > 0 && cursor.processed >= doc.options.maxProblems) break outer;
                        const sourcePid = normalizePid(list.result[i].pid);
                        seen.add(sourcePid);
                        cursor.sourceIndex = si;
                        cursor.page = page;
                        cursor.pidIndex = i + 1;
                        await processOne(id, sourcePid, doc, cursor);
                    }
                    const limitReached = doc.options.maxProblems > 0 && cursor.processed >= doc.options.maxProblems;
                    let lastPage = list.result.length < list.perPage
                        || (list.count > 0 && page >= Math.ceil(list.count / list.perPage));
                    // 末页二次确认：再拉同一页，避免反爬空壳导致提前收尾漏题
                    if (lastPage && !limitReached && list.count > 0) {
                        const before = list.result.length;
                        const again = await fetchProblemList({ type: source, page });
                        if (again.result.length > before) {
                            await log(id, `⚠️ 列表 ${source} 第 ${page} 页首次为空壳，二次确认拿到 ${again.result.length} 题，继续处理`);
                            // 只处理二次确认新增的部分，避免重复请求已处理的题
                            for (let k = before; k < again.result.length; k++) {
                                const st = await check();
                                if (st !== 'continue') break;
                                const p2 = normalizePid(again.result[k].pid);
                                seen.add(p2);
                                cursor.pidIndex = k + 1;
                                await processOne(id, p2, doc, cursor);
                            }
                            lastPage = false;
                        }
                    }
                    if (limitReached || lastPage) break;
                    if (maxPages > 0 && pagesForSource >= maxPages) {
                        await log(id, `小样验证模式：只拉取 ${maxPages} 页，任务到此结束（断点已保留）`);
                        finalStatus = 'done';
                        break outer;
                    }
                    page += 1;
                    cursor.sourceIndex = si;
                    cursor.page = page;
                    cursor.pidIndex = 0;
                    await db().updateOne({ _id: id }, {
                        $set: { cursor: { ...cursor }, heartbeat: Date.now(), updatedAt: Date.now() },
                    });
                }
                await log(id, `来源 ${source} 处理完毕（共 ${pagesForSource} 页，收录 ${seen.size} 题）`);
                // 完整跑完来源后才做题号补漏；小样 / 上限 / 非正常收尾不探测
                const cleanFinish = finalStatus === 'done' && doc.options.maxProblems === 0
                    && maxPages === 0 && seen.size > 0;
                if (cleanFinish) {
                    const gap = await probeGaps(
                        id, source, seen, doc, cursor, check,
                        async (pid) => processOne(id, pid, doc, cursor),
                    );
                    await db().updateOne({ _id: id }, {
                        $inc: { 'counts.probed': gap.probed, 'counts.recovered': gap.found },
                    });
                }
                if (doc.options.maxProblems > 0 && cursor.processed >= doc.options.maxProblems) break;
                cursor.sourceIndex = si + 1;
                cursor.page = 1;
                cursor.pidIndex = 0;
                await db().updateOne({ _id: id }, {
                    $set: { cursor: { ...cursor }, heartbeat: Date.now(), updatedAt: Date.now() },
                });
            }
        }
        if (finalStatus === 'done') {
            const latest = await getJobDoc(id);
            const c = latest?.counts || doc.counts;
            await log(id, `完成：成功 ${c.ok}，跳过 ${c.skipped}，失败 ${c.failed}`);
        }
    } catch (e) {
        finalStatus = 'error';
        errorMessage = e?.message || String(e);
        await log(id, `任务异常终止：${errorMessage}（断点已保留）`).catch(() => {});
        logger.error('job %s failed: %s', id, errorMessage);
    } finally {
        const finishedAt = Date.now();
        // 条件更新：不覆盖「暂停/取消」等由用户动作写入的状态
        await db().updateOne(
            { _id: id, status: 'running', runner: RUNNER_ID },
            {
                $set: {
                    status: finalStatus,
                    finishedAt,
                    updatedAt: finishedAt,
                    heartbeat: finishedAt,
                    error: errorMessage,
                },
                $push: { logs: { $each: [stamp(`任务状态：${finalStatus}`)], $slice: -MAX_LOGS } },
            },
        ).catch(() => {});
        active.delete(id);
    }
}

/** Web 请求里调用：不 await，后台串行执行 */
export function startJob(id: string) {
    runJob(id).catch((e) => logger.error('job %s crashed: %s', id, e?.message || e));
}

export async function controlJob(id: string, action: 'pause' | 'resume' | 'cancel') {
    const doc = await getJobDoc(id);
    if (!doc) throw new Error('任务不存在');
    const now = Date.now();
    if (action === 'pause') {
        if (!['queued', 'running', 'interrupted'].includes(doc.status)) {
            throw new Error(`当前状态 ${doc.status} 不能暂停`);
        }
        await db().updateOne({ _id: id }, { $set: { status: 'paused', updatedAt: now, heartbeat: now } });
        await log(id, '已暂停，进度已保存');
    } else if (action === 'resume') {
        if (!['paused', 'error', 'interrupted', 'cancelled'].includes(doc.status)) {
            throw new Error(`当前状态 ${doc.status} 不能继续`);
        }
        await db().updateOne({ _id: id }, {
            $set: { status: 'queued', updatedAt: now, heartbeat: now, error: '', runner: '' },
            $unset: { finishedAt: '' },
        });
        await log(id, '从断点继续');
        setTimeout(() => startJob(id), 1200);
    } else {
        if (['done', 'cancelled'].includes(doc.status)) throw new Error(`当前状态 ${doc.status} 无需取消`);
        await db().updateOne({ _id: id }, {
            $set: { status: 'cancelled', finishedAt: now, updatedAt: now, heartbeat: now },
        });
        await log(id, '已取消，进度已保留，可点「继续」恢复');
    }
    return getJobDoc(id);
}

/**
 * backend 启动时调用：把崩溃/重启遗留的任务重新排队并自动续跑。
 * 只在 master worker 上执行，避免 CLI 进程抢任务。
 */
export async function recoverJobs(): Promise<number> {
    if (process.env.NODE_APP_INSTANCE !== '0') return 0;
    // 启动时本进程还没有活着的 runner，遗留的未完成任务一律重新排队
    const docs: JobDoc[] = await db().find({
        status: { $in: ['running', 'queued', 'interrupted'] },
        runner: { $ne: RUNNER_ID },
    }).toArray();
    if (!docs.length) return 0;
    for (const doc of docs) {
        await db().updateOne({ _id: doc._id }, {
            $set: { status: 'queued', runner: '', updatedAt: Date.now() },
            $push: { logs: { $each: [stamp('服务重启，任务从断点自动续跑')], $slice: -MAX_LOGS } },
        });
        startJob(doc._id);
    }
    logger.info('recovered %d interrupted jobs', docs.length);
    return docs.length;
}

/** 页面展示用的任务状态（不回传大数组） */
export async function jobStatus(id: string) {
    const doc = await getJobDoc(id);
    if (!doc) return null;
    return {
        id: doc._id,
        mode: doc.mode,
        status: doc.status,
        sources: doc.sources,
        cursor: doc.cursor,
        counts: doc.counts,
        options: {
            domainId: doc.options.domainId,
            samples: doc.options.samples,
            hidden: doc.options.hidden,
            overwrite: doc.options.overwrite,
            sources: doc.options.sources,
            maxProblems: doc.options.maxProblems,
            delayMs: doc.options.delayMs,
            requireLogin: doc.options.requireLogin,
        },
        estimate: doc.estimate,
        logs: doc.logs,
        startedAt: doc.startedAt,
        finishedAt: doc.finishedAt,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        error: doc.error,
        running: doc.status === 'running',
    };
}
