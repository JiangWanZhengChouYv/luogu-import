import {
    Context, Handler, Logger, ObjectId, PRIV, ProblemModel, RecordModel, SettingModel, STATUS,
    STATUS_TEXTS, ValidationError,
} from 'hydrooj';
import {
    CaptchaRequiredError, clearAuthCookie, fetchCaptchaImage, fetchLuoguRecord,
    fetchTags, getDelay, hasAuthCookie, setAuthCookie, submitCode, verifyLogin,
} from './src/client';
import {
    importProblem, resolvePids, setSourceMarker, JobSpec, SampleMode,
} from './src/importer';
import {
    formatRecord, getSourcePid, initSourceMarkers, isLuoguProblem, LANG_MAP,
    looksLikeLuoguPid, markLuoguProblem, resolveLang,
} from './src/submit';
import {
    clearCredentials, getPublicConfig, initConfig, loadCredentials, saveCredentials,
} from './src/config';
import {
    clearAccount, getAccountInfo, initAccounts, loadAccount,
    saveAccount, saveProfile,
} from './src/accounts';
import {
    controlJob, createJob, estimate as estimateJob, initJobs, jobStatus,
    listJobs, recoverJobs, runJob, startJob,
} from './src/jobs';
import {
    finishFix, getOracle, getSubmission, initOracle, listFixes, regenerateSamples,
    saveOracle, saveSubmission, setLocalRid,
} from './src/oracle';

const logger = new Logger('luogu-import');

const DEFAULT_SOURCES = ['P', 'B', 'CF', 'SP', 'AT', 'UVA'];
const MAX_MANUAL = 5000;
/** Hydro record 终态：AC / WA / TLE / MLE / OLE / RE / CE / SE / CANCELED */
const TERMINAL_STATUS = new Set<number>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 30, 31, 32, 33]);
/** 洛谷的 AC 状态码是 12，和 Hydro 的 STATUS_ACCEPTED=1 不是一回事 */
const LUOGU_STATUS_ACCEPTED = 12;

function parseSpec(body: any): JobSpec {
    const spec: JobSpec = {};
    if (body.pids) {
        spec.pids = String(body.pids).split(/[\s,，;；]+/).filter(Boolean);
    }
    if (body.range) spec.range = String(body.range);
    if (body.mode === 'list' || body.list) {
        const list = body.list || {};
        spec.list = {
            type: list.type || 'P',
            keyword: list.keyword || undefined,
            difficulty: Array.isArray(list.difficulty)
                ? list.difficulty.map(Number).filter((i: number) => Number.isFinite(i))
                : undefined,
            tag: Array.isArray(list.tag)
                ? list.tag.map(Number).filter((i: number) => Number.isFinite(i))
                : undefined,
            pages: Number(list.pages) || 1,
        };
    }
    return spec;
}

function specIsEmpty(spec: JobSpec) {
    return !(spec.pids && spec.pids.length) && !spec.range && !spec.list;
}

function parseSources(raw: any): string[] {
    const arr = Array.isArray(raw)
        ? raw
        : String(raw || DEFAULT_SOURCES.join(',')).split(/[\s,，]+/);
    return Array.from(new Set(
        arr.map((s) => String(s).trim().toUpperCase())
            .filter((s) => /^[A-Z0-9]{1,8}$/.test(s)),
    ));
}

function sampleMode(raw: any): SampleMode {
    return ['first', 'all', 'none'].includes(raw) ? raw : 'first';
}

function numberOr(raw: any, fallback: number) {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 提交账号：优先当前用户自己绑定的；未绑定时按约定回退全站拉题账号。
 * 只读拉题账号，绝不因为用户登录而修改它。
 */
async function resolveSubmitCredentials(hydroUid: number) {
    const own = await loadAccount(hydroUid);
    if (own) return { ...own, source: 'own' as const };
    const shared = await loadCredentials();
    if (shared) return { ...shared, source: 'shared' as const };
    return null;
}

function submitCookie(creds: { uid: string; clientId: string }) {
    return `_uid=${creds.uid}; __client_id=${creds.clientId}`;
}

function buildOptions(body: any, owner: number, sources: string[]) {
    return {
        domainId: String(body.domainId || 'system'),
        owner,
        hidden: !!body.hidden,
        overwrite: !!body.overwrite,
        samples: sampleMode(body.samples),
        sources,
        maxProblems: body.maxProblems === undefined
            ? (body.mode === 'full' ? 0 : MAX_MANUAL)
            : Math.max(0, Math.floor(numberOr(body.maxProblems, 0))),
        delayMs: Math.max(300, Math.floor(numberOr(body.delayMs, 1500))),
        requireLogin: body.allowAnonymous !== true,
    };
}

class LuoguImportBaseHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }
}

class LuoguImportPageHandler extends LuoguImportBaseHandler {
    async get() {
        this.response.template = 'luogu_import.html';
        this.response.body = {
            domainId: this.args.domainId || 'system',
            defaultSources: DEFAULT_SOURCES.join(','),
            delayMs: getDelay(),
            sources: DEFAULT_SOURCES,
        };
    }
}

class LuoguConfigHandler extends LuoguImportBaseHandler {
    async get() {
        this.response.body = {
            config: await getPublicConfig(),
            loginActive: hasAuthCookie(),
        };
    }

    async post() {
        const body = this.request.body || {};
        if (body.action === 'clear') {
            await clearCredentials();
            clearAuthCookie();
            logger.info('Luogu credentials cleared by %s', this.user.uname);
            this.response.body = { config: await getPublicConfig(), loginActive: false };
            return;
        }
        const uid = String(body.uid || '').trim();
        const clientId = String(body.clientId || '').trim();
        // 只记录 uid 与长度，绝不记录值
        try {
            await saveCredentials(uid, clientId);
        } catch (e) {
            throw new ValidationError(e.message || '保存登录态失败');
        }
        setAuthCookie(uid, clientId);
        logger.info('Luogu credentials saved by %s (uid=%s, clientId length=%d)',
            this.user.uname, uid, clientId.length);
        this.response.body = { config: await getPublicConfig(), loginActive: true };
    }
}

class LuoguTestLoginHandler extends LuoguImportBaseHandler {
    async post() {
        const body = this.request.body || {};
        let uid = String(body.uid || '').trim();
        let clientId = String(body.clientId || '').trim();
        if (!uid || !clientId) {
            const saved = await loadCredentials();
            if (saved) {
                uid = saved.uid;
                clientId = saved.clientId;
            }
        }
        if (!uid || !clientId) {
            throw new ValidationError('请先在「洛谷账号」区配置 _uid 与 __client_id');
        }
        try {
            const result = await verifyLogin(uid, clientId);
            logger.info('Luogu login verified for uid %s by %s', uid, this.user.uname);
            this.response.body = {
                ok: true,
                uid: result.uid,
                uname: result.uname,
                clientIdLength: clientId.length,
            };
        } catch (e) {
            throw new ValidationError(e.message || '登录校验失败');
        }
    }
}

class LuoguEstimateHandler extends LuoguImportBaseHandler {
    async get() {
        const sources = parseSources(this.args.sources || DEFAULT_SOURCES.join(','));
        if (!sources.length) throw new ValidationError('请至少选择一个来源');
        const samples = sampleMode(this.args.samples);
        const delayMs = Math.max(300, Math.floor(numberOr(this.args.delay, 1500)));
        this.response.body = { estimate: await estimateJob(sources, samples, delayMs) };
    }
}

class LuoguImportStartHandler extends LuoguImportBaseHandler {
    async post() {
        const body = this.request.body || {};
        const full = body.mode === 'full';
        const sources = full ? parseSources(body.sources) : [];
        const options = buildOptions(body, this.user._id, sources);

        if (full) {
            if (!sources.length) throw new ValidationError('请至少选择一个来源');
            const config = await getPublicConfig();
            if (options.requireLogin && !config.configured) {
                throw new ValidationError('全量拉取要求先配置洛谷登录态；如只需抓取公开题，请勾选「允许匿名抓取公开题」');
            }
            const est = await estimateJob(sources, options.samples, options.delayMs);
            const job = await createJob({
                mode: 'full',
                sources,
                options,
                estimate: est,
                owner: this.user._id,
                maxPages: Math.max(0, Math.floor(numberOr(body.maxPages, 0))),
            });
            startJob(job._id);
            logger.info('full import job %s started by %s: %s', job._id, this.user.uname, sources.join('/'));
            this.response.body = { jobId: job._id, mode: 'full', estimate: est };
            return;
        }

        const spec = parseSpec(body);
        if (specIsEmpty(spec)) throw new ValidationError('请至少填写题号、题号区间或题目列表筛选条件之一');
        const job = await createJob({
            mode: 'manual', spec, options, owner: this.user._id,
        });
        startJob(job._id);
        logger.info('manual import job %s started by %s', job._id, this.user.uname);
        this.response.body = { jobId: job._id, mode: 'manual' };
    }
}

class LuoguImportStatusHandler extends LuoguImportBaseHandler {
    async get() {
        const id = String(this.args.jobId || '');
        const job = id ? await jobStatus(id) : null;
        if (!job) throw new ValidationError('任务不存在或已过期');
        this.response.body = job;
    }
}

class LuoguJobsHandler extends LuoguImportBaseHandler {
    async get() {
        this.response.body = { jobs: await listJobs(20) };
    }
}

class LuoguJobActionHandler extends LuoguImportBaseHandler {
    async post() {
        const body = this.request.body || {};
        const id = String(body.jobId || '');
        const action = String(body.action || '');
        if (!id || !['pause', 'resume', 'cancel'].includes(action)) {
            throw new ValidationError('参数错误：需要 jobId 与 pause/resume/cancel');
        }
        try {
            await controlJob(id, action as 'pause' | 'resume' | 'cancel');
        } catch (e) {
            throw new ValidationError(e.message || '操作失败');
        }
        this.response.body = { ok: true, job: await jobStatus(id) };
    }
}

class LuoguImportTagsHandler extends LuoguImportBaseHandler {
    async get() {
        const tags = await fetchTags();
        this.response.body = {
            tags: tags
                .filter((t) => t.name)
                .map((t) => ({ id: t.id, name: t.name })),
        };
    }
}

/* ---------------- 洛谷远端提交（不改 Hydro record） ---------------- */

class LuoguSubmitBaseHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    async resolveProblem() {
        const pid = String(this.args.pid || '');
        const domainId = String(this.args.domainId || 'system');
        const pdoc = await ProblemModel.get(domainId, pid);
        if (!pdoc) throw new ValidationError('题目不存在');
        const hydroPid = String(pdoc.pid || pid);
        const realDomainId = String(pdoc.domainId || domainId);
        if (!await isLuoguProblem(realDomainId, hydroPid)) {
            throw new ValidationError('该题不是洛谷题，无法提交到 Luogu');
        }
        return { pdoc, hydroPid, domainId: realDomainId };
    }
}

class LuoguSubmitHandler extends LuoguSubmitBaseHandler {
    async get() {
        const { pdoc, hydroPid } = await this.resolveProblem();
        const langRange: Record<string, string> = {};
        for (const [key, cfg] of Object.entries(SettingModel.langs || {})) {
            const c = cfg as any;
            if (c?.hidden || c?.disabled) continue;
            langRange[key] = c?.display || key;
        }
        const credentials = await resolveSubmitCredentials(this.user._id);
        const accountInfo = await getAccountInfo(this.user._id);
        this.response.template = 'luogu_submit.html';
        this.response.body = {
            pdoc,
            langRange,
            supported: Object.keys(LANG_MAP),
            page_name: 'problem_submit',
            luoguPid: hydroPid,
            codeLang: (this.user as any).codeLang || 'cc.cc14o2',
            loginConfigured: !!credentials,
            accountSource: credentials?.source || 'none',
            accountProfile: accountInfo.configured ? accountInfo.profile || null : null,
            submitUrl: `/luogu/submit/${encodeURIComponent(hydroPid)}`,
        };
    }

    async post() {
        const body = this.request.body || {};
        const { pdoc, hydroPid, domainId } = await this.resolveProblem();
        const code = String(body.code || '');
        if (!code.trim()) throw new ValidationError('代码不能为空');
        const mapping = resolveLang(String(body.lang || ''));
        if (!mapping) throw new ValidationError(`洛谷暂不支持语言 ${body.lang}，请选择 C++ 系列`);
        const credentials = await resolveSubmitCredentials(this.user._id);
        if (!credentials) throw new ValidationError('未绑定洛谷提交账号，请先到「第三方账号」页绑定自己的账号');
        const cookie = submitCookie(credentials);
        const sourcePid = await getSourcePid(domainId, hydroPid);
        try {
            const rid = await submitCode({
                pid: sourcePid,
                code,
                lang: mapping.lang,
                enableO2: mapping.enableO2,
                captcha: body.captcha ? String(body.captcha) : undefined,
                cookie,
            });
            // 只记录 uid、题号、rid，绝不记录 cookie；代码只留在 submissions 里供 AC 后当标程
            logger.info('Luogu submit by %s: %s -> rid %s (lang %s)', this.user.uname, sourcePid, rid, body.lang);
            let localRid = '';
            try {
                await saveSubmission({
                    rid, domainId, docId: pdoc.docId, uid: this.user._id,
                    code, lang: String(body.lang),
                });
                // 同一次提交也在本地评测一次（用题目已有测试点），与洛谷结果并列展示
                const lrid = await RecordModel.add(
                    domainId, pdoc.docId, this.user._id, String(body.lang), code, true,
                    { type: 'judge' },
                );
                localRid = lrid.toString();
                await setLocalRid(rid, localRid);
                logger.info('Local judge for luogu rid %s: %s', rid, localRid);
            } catch (e) {
                logger.warn('local judge failed for %s: %s', rid, e?.message || e);
            }
            this.response.body = {
                ok: true, rid, localRid, lang: mapping.label, luoguPid: sourcePid,
            };
        } catch (e) {
            const message = e?.message || '提交失败';
            // 无论洛谷返回哪种形态，只要提示了验证码就必须让前端弹出图片输入区
            if (e instanceof CaptchaRequiredError || /验证码|captcha/i.test(message)) {
                let image = '';
                let imageError = '';
                try {
                    image = await fetchCaptchaImage(cookie);
                } catch (ce: any) {
                    imageError = ce?.message || '验证码图片获取失败';
                    logger.warn('Luogu captcha image failed: %s', imageError);
                }
                this.response.body = {
                    needCaptcha: true, image, imageError, message,
                    luoguUrl: `https://www.luogu.com.cn/problem/${encodeURIComponent(sourcePid)}`,
                };
                return;
            }
            throw new ValidationError(message);
        }
    }
}

class LuoguCaptchaHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    async get() {
        const credentials = await resolveSubmitCredentials(this.user._id);
        if (!credentials) throw new ValidationError('未绑定洛谷提交账号');
        const cookie = submitCookie(credentials);
        try {
            this.response.body = { image: await fetchCaptchaImage(cookie) };
        } catch (e) {
            // 返回 200 让前端能显示「图片获取失败 + 换一张」，而不是直接抛异常导致弹窗消失
            this.response.body = { image: '', imageError: e?.message || '验证码获取失败' };
        }
    }
}

/** 读题目测试点文件的内容预览（只取前几个字符，避免把大数据回给前端） */
/**
 * 测试点内容预览。Hydro 本地存储的 etag 就是文件真实路径的 base64
 * （见 storage.ts: getMeta → Buffer.from(target).toString('base64')），
 * 所以从 pdoc.data 的 etag 解出路径直接读；StorageService 是跨进程 proxy，
 * 在 backend 里拿不到它写出的流/临时文件。
 */
async function previewTestdata(meta: any, limit = 120): Promise<string> {
    if (!meta?.etag) return '';
    try {
        const { readFileSync } = await import('fs');
        const path = Buffer.from(String(meta.etag), 'base64').toString('utf8');
        return readFileSync(path, 'utf8').slice(0, limit);
    } catch {
        return '';
    }
}

class LuoguRecordHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    async get() {
        const rid = String(this.args.rid || '');
        const credentials = await resolveSubmitCredentials(this.user._id);
        if (!credentials) throw new ValidationError('未绑定洛谷提交账号');
        try {
            const raw = await fetchLuoguRecord(rid, submitCookie(credentials));
            const result: any = formatRecord(rid, raw);

            // 附上同一次提交的本地评测结果，前端在原生评测记录面板里并列展示
            const submission = await getSubmission(rid);
            if (submission?.localRid) {
                const local = await RecordModel.coll.findOne({ _id: new ObjectId(submission.localRid) });
                if (local) {
                    result.local = {
                        rid: submission.localRid,
                        status: local.status,
                        statusText: STATUS_TEXTS[local.status] || String(local.status),
                        terminal: TERMINAL_STATUS.has(local.status),
                        score: local.score,
                        timeMs: local.time,
                        memoryKb: local.memory,
                    };
                }
            }

            // 洛谷 AC 的 status 是 12（Hydro 自己的 AC 才是 1），别混用！
            // 每次 AC 都把这份代码存为标程并触发一次反算（同一 hash 幂等，不会反复重算）。
            // 注意：本地 FE（status 31）是「普通提交评测模式下没提交过洛谷、先用样例当评测数据」
            // 的预期结果，不代表样例有问题，绝不能据此写「洛谷 AC 但本地 Format Error」这种误导理由。
            if (result.terminal && result.status === LUOGU_STATUS_ACCEPTED && submission) {
                const saved = await saveOracle(
                    submission.domainId, submission.docId, this.user._id,
                    submission.code, rid,
                );
                result.oracle = saved.changed ? 'saved' : 'exists';
                const localBad = result.local?.terminal
                    && ![STATUS.STATUS_ACCEPTED, STATUS.STATUS_FORMAT_ERROR].includes(result.local.status);
                const reason = localBad
                    ? `洛谷 AC 但本地 ${result.local.statusText}` : '洛谷 AC 提交自动反算';
                const fix = await regenerateSamples(
                    submission.domainId, submission.docId, this.user._id, { reason },
                );
                result.sampleFix = fix;
                logger.info('sample regeneration for %s/%s: %s', submission.domainId, submission.docId, fix.message);
            }

            // 反算任务终态时收尾（generate 任务完成后 judge 已写回样例）
            if (submission) {
                const fixes = await listFixes(submission.domainId, submission.docId);
                for (const fix of fixes) {
                    if (fix.status !== 'pending') continue;
                    const g = await RecordModel.get(submission.domainId, fix.generateRid);
                    if (g && TERMINAL_STATUS.has(g.status)) {
                        await finishFix(fix.generateRid, g.status === STATUS.STATUS_ACCEPTED ? 'done' : 'failed');
                        fix.status = g.status === STATUS.STATUS_ACCEPTED ? 'done' : 'failed';
                    }
                }
                // 学生端接口不返回反算详情/样例内容；管理员可到 /manage/luogu/oracle/:pid 查看
            }
            this.response.body = result;
        } catch (e) {
            throw new ValidationError(e?.message || '获取评测结果失败');
        }
    }
}

/** 批量删题：只保留指定 pid，其余全删（仅管理员，运维用） */
class LuoguProblemCleanupHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async post() {
        const domainId = String(this.request.body?.domainId || 'system');
        const keep = new Set(
            String(this.request.body?.keep || 'P1001').split(/[\s,，]+/).filter(Boolean),
        );
        const all = await ProblemModel.getMulti(domainId)
            .project({ docId: 1, pid: 1 }).toArray();
        const toDelete = all.filter((p: any) => !keep.has(String(p.pid)));
        const deleted: string[] = [];
        const failed: string[] = [];
        for (const p of toDelete) {
            try {
                await ProblemModel.del(domainId, p.docId);
                deleted.push(String(p.pid));
            } catch (e) {
                failed.push(`${p.pid}: ${(e as Error)?.message || e}`);
            }
        }
        this.response.body = { total: all.length, deleted: deleted.length, failed, keep: [...keep] };
    }
}

/** 反算样例：查看状态 / 手动触发（仅管理员） */
class LuoguOracleHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async get() {
        const domainId = String(this.args.domainId || 'system');
        const pid = String(this.args.pid || '');
        const pdoc = await ProblemModel.get(domainId, pid);
        if (!pdoc) throw new ValidationError('题目不存在');
        let fixes = await listFixes(domainId, pdoc.docId);
        // 收尾：generate 任务已终态的修复记录更新为 done/failed
        let touched = false;
        for (const fix of fixes) {
            if (fix.status !== 'pending') continue;
            // RecordModel.get 期望 ObjectId；这里直接查 coll 用字符串 rid 更简单
            const g = await RecordModel.coll.findOne({ _id: new ObjectId(fix.generateRid) });
            if (g && TERMINAL_STATUS.has(g.status)) {
                const next = g.status === STATUS.STATUS_ACCEPTED ? 'done' : 'failed';
                await finishFix(fix.generateRid, next);
                fix.status = next;
                touched = true;
            }
        }
        // finishFix 会写入 pairs / maxStdTime / worst / 升档后的新记录，重查一次再返回，
        // 否则前端看到的是收尾前的旧文档（stats 全是 null）。
        if (touched) fixes = await listFixes(domainId, pdoc.docId);
        const oracle = await getOracle(domainId, pdoc.docId);
        // 管理员接口才返回样例内容预览（学生端评测弹窗不显示任何反算信息）
        let preview: any[] = [];
        if (fixes.some((f: any) => f.status === 'done')) {
            const metas: any[] = (pdoc.data || [])
                .filter((f: any) => /^\d+\.(in|out)$/.test(String(f.name || '')))
                .sort((a: any, b: any) => parseInt(a.name) - parseInt(b.name));
            for (const m of metas.slice(0, 20)) {
                preview.push({ name: m.name, content: await previewTestdata(m) });
            }
        }
        this.response.body = {
            oracle: oracle ? { hash: oracle.hash, uid: oracle.uid, rid: oracle.rid, updatedAt: oracle.updatedAt } : null,
            fixes,
            preview,
        };
    }

    async post() {
        const domainId = String(this.args.domainId || 'system');
        const pid = String(this.args.pid || '');
        const pdoc = await ProblemModel.get(domainId, pid);
        if (!pdoc) throw new ValidationError('题目不存在');
        const result = await regenerateSamples(
            domainId, pdoc.docId, this.user._id,
            {
                reason: '管理员手动触发',
                force: !!this.request.body?.force,
                scale: Number(this.request.body?.scale) || undefined,
            },
        );
        this.response.body = result;
    }
}

/* ---------------- 第三方账号：按用户独立保存提交账号 ---------------- */

class LuoguAccountBaseHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
    }

    async verifyOwnAccount() {
        const creds = await loadAccount(this.user._id);
        if (!creds) throw new ValidationError('请先绑定洛谷提交账号');
        try {
            const result = await verifyLogin(creds.uid, creds.clientId);
            const profile = { ...result.profile, verifiedAt: Date.now() };
            await saveProfile(this.user._id, profile);
            return { uid: result.uid, uname: result.uname, profile };
        } catch (e) {
            throw new ValidationError(e?.message || '登录校验失败');
        }
    }
}

class LuoguAccountPageHandler extends LuoguAccountBaseHandler {
    async get() {
        const account = await getAccountInfo(this.user._id);
        this.response.template = 'luogu_account.html';
        this.response.body = {
            page_name: 'luogu_account',
            account,
            // 直接给前端 JSON，避免依赖模板的 dump 过滤器；转义 < 防止 </script> 注入
            accountJSON: JSON.stringify(account).replace(/</g, '\\u003c'),
            sharedAvailable: !!(await loadCredentials()),
            hydroUser: this.user.uname,
        };
    }
}

class LuoguAccountHandler extends LuoguAccountBaseHandler {
    async post() {
        const body = this.request.body || {};
        if (body.action === 'clear') {
            await clearAccount(this.user._id);
            this.response.body = { ok: true, account: await getAccountInfo(this.user._id) };
            return;
        }
        if (body.action === 'verify') {
            this.response.body = { ok: true, ...(await this.verifyOwnAccount()) };
            return;
        }
        await saveAccount(this.user._id, String(body.uid || ''), String(body.clientId || ''));
        // 保存后立刻校验并缓存公开资料；校验失败不阻断保存
        let profile = null;
        try {
            profile = (await this.verifyOwnAccount()).profile;
        } catch (e) {
            logger.warn('profile verify after save failed: %s', e.message);
        }
        this.response.body = {
            ok: true,
            account: await getAccountInfo(this.user._id),
            profile,
        };
    }
}

class LuoguAccountProfileHandler extends LuoguAccountBaseHandler {
    async get() {
        const info = await getAccountInfo(this.user._id);
        const creds = await loadAccount(this.user._id);
        if (!creds) {
            this.response.body = { account: info, profile: info.profile || null, verified: false };
            return;
        }
        try {
            const result = await verifyLogin(creds.uid, creds.clientId);
            const profile = { ...result.profile, verifiedAt: Date.now() };
            await saveProfile(this.user._id, profile);
            this.response.body = { account: { ...info, profile }, profile, verified: true };
        } catch (e) {
            // 自动展示仍返回缓存资料，校验失败单独给提示
            this.response.body = {
                account: info,
                profile: info.profile || null,
                verified: false,
                message: e?.message || '登录校验失败',
            };
        }
    }
}

export async function apply(ctx: Context) {
    const mongo = (ctx as any).db?.db;
    if (mongo) {
        initConfig(mongo.collection('luogu.config'));
        initJobs(mongo.collection('luogu.job'));
        initSourceMarkers(mongo.collection('luogu.problems'));
        initAccounts(mongo.collection('luogu.accounts'));
        initOracle(mongo);
        setSourceMarker(markLuoguProblem);
        try {
            const credentials = await loadCredentials();
            if (credentials) {
                // 全局 cookie 只服务「拉题账号」；提交账号一律由各用户自己绑定
                setAuthCookie(credentials.uid, credentials.clientId);
            }
        } catch (e) {
            logger.warn('load credentials failed: %s', e.message);
        }
    } else {
        logger.warn('database not ready at apply(); persistence disabled in this process');
    }

    ctx.Route('luogu_import', '/manage/luogu', LuoguImportPageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('luogu_import_config', '/manage/luogu/config', LuoguConfigHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('luogu_test_login', '/manage/luogu/test-login', LuoguTestLoginHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('luogu_estimate', '/manage/luogu/estimate', LuoguEstimateHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('luogu_import_start', '/manage/luogu/import', LuoguImportStartHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('luogu_import_status', '/manage/luogu/status', LuoguImportStatusHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('luogu_import_jobs', '/manage/luogu/jobs', LuoguJobsHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('luogu_import_action', '/manage/luogu/job-action', LuoguJobActionHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('luogu_import_tags', '/manage/luogu/tags', LuoguImportTagsHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.injectUI('ControlPanel', 'luogu_import', { icon: 'download' });

    // 洛谷题的提交入口（登录用户即可，UI 与原生提交页一致）
    ctx.Route('luogu_submit', '/luogu/submit/:pid', LuoguSubmitHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('luogu_record', '/luogu/record/:rid', LuoguRecordHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('luogu_captcha', '/luogu/captcha', LuoguCaptchaHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('luogu_oracle', '/manage/luogu/oracle/:pid', LuoguOracleHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('luogu_cleanup', '/manage/luogu/cleanup', LuoguProblemCleanupHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route('luogu_account', '/luogu/account', LuoguAccountPageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('luogu_account_save', '/luogu/account/save', LuoguAccountHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('luogu_account_profile', '/luogu/account/profile', LuoguAccountProfileHandler, PRIV.PRIV_USER_PROFILE);
    // 与首页 / 题库 / 训练 / 比赛同级，插在「记录」之前
    ctx.injectUI('Nav', 'luogu_account', { prefix: 'luogu', before: 'record_main' }, PRIV.PRIV_USER_PROFILE);

    // 题目详情页：handler/create 阶段路由参数尚未解析，从 URL 里取 pid 做同步判定；
    // 标记集合（luogu.problems）由提交接口的 isLuoguProblem() 负责，二者结合。
    ctx.on('handler/create', (h: any) => {
        const path = String(h?.request?.path || '');
        const m = path.match(/^\/p\/([^/]+)\/?$/);
        if (!m) return;
        const pid = decodeURIComponent(m[1]);
        // response.body 会在 handler 执行时被重建，UiContext 是稳定的同一对象
        if (looksLikeLuoguPid(pid) && h?.UiContext) h.UiContext.isLuoguProblem = true;
    }, { global: true } as any);

    ctx.addScript(
        'luoguImport',
        'Import problems from Luogu. Args: {pids, range, list} or {mode:"full", sources, maxPages, maxProblems, delayMs, samples, domainId, hidden, overwrite, allowAnonymous}',
        null,
        async (args: any, report: (payload: any) => void) => {
            const a = args || {};
            if (a.mode === 'full') {
                const sources = parseSources(a.sources);
                const options = buildOptions(a, Number(a.owner) || 1, sources);
                const job = await createJob({
                    mode: 'full', sources, options, owner: options.owner,
                    maxPages: Math.max(0, Math.floor(numberOr(a.maxPages, 0))),
                });
                report({ message: `全量任务 ${job._id} 已创建：${sources.join('/')}` });
                await runJob(job._id);
                const final = await jobStatus(job._id);
                report({ message: `任务结束：${final?.status}，成功 ${final?.counts.ok}，跳过 ${final?.counts.skipped}，失败 ${final?.counts.failed}` });
                return true;
            }
            const spec = parseSpec(a);
            if (specIsEmpty(spec)) throw new Error('请至少提供 pids / range / list 之一');
            const pids = await resolvePids(spec);
            if (!pids.length) throw new Error('没有解析出任何题号');
            if (pids.length > MAX_MANUAL) throw new Error(`单次最多导入 ${MAX_MANUAL} 题`);
            const opts = {
                domainId: String(a.domainId || 'system'),
                owner: Number(a.owner) || 1,
                hidden: !!a.hidden,
                overwrite: !!a.overwrite,
                samples: sampleMode(a.samples),
            };
            report({ message: `开始导入 ${pids.length} 题到 ${opts.domainId}` });
            for (const pid of pids) {
                try {
                    const item = await importProblem(pid, opts);
                    if (item.status === 'ok') report({ message: `✅ ${pid} -> docId ${item.docId} (${(item.languages || []).join('/')})` });
                    else if (item.status === 'skipped') report({ message: `⏭️ ${pid} 已存在，跳过` });
                    else report({ message: `❌ ${pid} 失败：${item.message}` });
                } catch (e) {
                    report({ message: `❌ ${pid} 失败：${e.message || e}` });
                }
            }
            report({ message: '导入结束' });
            return true;
        },
    );

    // 服务启动后把崩溃/重启遗留的任务从断点自动续跑
    ctx.on('app/started', async () => {
        try {
            const count = await recoverJobs();
            if (count) logger.info('auto-resumed %d interrupted import jobs', count);
        } catch (e) {
            logger.warn('recover jobs failed: %s', e.message);
        }
    });
}
