/**
 * 洛谷（luogu.com.cn）访问客户端。
 *
 * - 匿名访问：首次请求 302 回自身并下发 C3VK，cookie jar 跟随 302 后拿到页面。
 * - 登录访问：后台配置 _uid + __client_id 后注入 cookie；未配置仍可匿名抓公开题。
 * - 题面数据在页面里的 <script type="application/json"> 块；
 *   data.translations 是全部语言版本（洛谷 content/contenu 只是其中一种）。
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const LUOGU = 'https://www.luogu.com.cn';

/** host -> cookie 键值，进程内复用，减少一次 302 */
const jar = new Map<string, string>();
let authCookie = '';

export function setAuthCookie(uid: string, clientId: string) {
    authCookie = `_uid=${uid}; __client_id=${clientId}`;
}

export function clearAuthCookie() {
    authCookie = '';
}

export function hasAuthCookie() {
    return !!authCookie;
}

function putCookies(target: Map<string, string>, raw: string) {
    for (const part of String(raw || '').split(';')) {
        const pair = part.trim();
        const idx = pair.indexOf('=');
        if (idx > 0) target.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
}

/** jar（C3VK 等） -> 登录 cookie -> 环境变量 -> 本次临时 cookie，后者覆盖同名 */
function cookieHeader(extra?: string) {
    const merged = new Map(jar);
    if (authCookie) putCookies(merged, authCookie);
    if (process.env.LUOGU_COOKIE) putCookies(merged, process.env.LUOGU_COOKIE);
    if (extra) putCookies(merged, extra);
    return Array.from(merged, ([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(res: any) {
    let list: string[] = [];
    if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
    else if (res.headers.get('set-cookie')) list = [res.headers.get('set-cookie')];
    for (const raw of list) {
        const pair = String(raw).split(';')[0];
        const idx = pair.indexOf('=');
        if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 全局请求节流，避免把洛谷打挂；全量任务可临时调高 */
let delayMs = Math.max(300, Number(process.env.LUOGU_DELAY_MS) || 1200);

export function getDelay() {
    return delayMs;
}

export function setDelay(ms: number) {
    delayMs = Math.max(300, Number(ms) || 1200);
}

let lastRequest = 0;

async function throttle() {
    const wait = lastRequest + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    await sleep(100 + Math.floor(Math.random() * 250));
}

export interface FetchOptions {
    /** 仅本次请求附加的 cookie（例如「测试登录」用的临时凭据） */
    cookie?: string;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
    let lastError: any;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await sleep(1500 * attempt);
        await throttle();
        try {
            let current = url;
            for (let hop = 0; hop < 6; hop++) {
                const headers: Record<string, string> = {
                    'User-Agent': UA,
                    Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    Referer: LUOGU + '/problem/list',
                };
                const cookie = cookieHeader(opts.cookie);
                if (cookie) headers.Cookie = cookie;
                const res: any = await fetch(current, {
                    headers,
                    redirect: 'manual',
                    signal: AbortSignal.timeout(30000),
                });
                absorbCookies(res);
                if (res.status >= 300 && res.status < 400) {
                    const loc = res.headers.get('location');
                    if (!loc) throw new Error(`HTTP ${res.status} 但没有跳转地址`);
                    current = new URL(loc, current).toString();
                    continue;
                }
                if (res.status === 200) return await res.text();
                if (res.status === 404) throw new Error('洛谷返回 404，题目不存在');
                if (res.status === 403) throw new Error('洛谷返回 403，可能触发了访问限制');
                throw new Error(`HTTP ${res.status}`);
            }
            throw new Error('跳转次数过多');
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError;
}

/** 页面里所有 application/json 块（用户页 / 标签页也用得上） */
export function parseJsonBlocks(html: string): any[] {
    const out: any[] = [];
    const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        try {
            out.push(JSON.parse(m[1]));
        } catch { /* 不是目标块，继续 */ }
    }
    return out;
}

/** 从页面里的 JSON 块取主数据（problem 或 problems） */
export function parsePayload(html: string): any {
    for (const data of parseJsonBlocks(html)) {
        if (data && data.data && (data.data.problem || data.data.problems)) return data;
    }
    throw new Error('无法解析洛谷页面数据（页面结构可能已变化）');
}

export interface LuoguStatement {
    name: string;
    background: string;
    description: string;
    formatI: string;
    formatO: string;
    hint: string;
    locale: string;
}

export interface LuoguProblem {
    pid: string;
    type: string;
    name: string;
    difficulty: number;
    tags: number[];
    /** locale -> 该语言的题面；来自 data.translations */
    statements: Record<string, LuoguStatement>;
    samples: Array<[string, string]>;
    limits: { time: number; memory: number };
}

function asText(v: any): string {
    if (v === null || v === undefined) return '';
    return String(v);
}

function toStatement(raw: any, locale: string, fallbackName: string): LuoguStatement {
    const c = raw && typeof raw === 'object' ? raw : { description: asText(raw) };
    return {
        name: asText(c.name) || fallbackName,
        background: asText(c.background),
        description: asText(c.description),
        formatI: asText(c.formatI),
        formatO: asText(c.formatO),
        hint: asText(c.hint),
        locale: asText(c.locale) || locale,
    };
}

export async function fetchProblem(pid: string): Promise<LuoguProblem> {
    const html = await fetchText(`${LUOGU}/problem/${encodeURIComponent(pid)}`);
    const payload = parsePayload(html);
    const p = payload.data.problem;
    if (!p) throw new Error('题目不存在或已被隐藏');
    const translations = payload.data.translations;
    const statements: Record<string, LuoguStatement> = {};
    if (translations && typeof translations === 'object') {
        for (const [locale, raw] of Object.entries(translations)) {
            if (raw && typeof raw === 'object') statements[locale] = toStatement(raw, locale, asText(p.name) || pid);
        }
    }
    // 老页面/无 translations 时退回 content + contenu
    if (!Object.keys(statements).length) {
        if (p.content) statements[asText(p.content.locale) || 'zh-CN'] = toStatement(p.content, 'zh-CN', asText(p.name) || pid);
        if (p.contenu) {
            const loc = asText(p.contenu.locale) || 'zh-CN';
            if (!statements[loc]) statements[loc] = toStatement(p.contenu, loc, asText(p.name) || pid);
        }
    }
    const samples = Array.isArray(p.samples)
        ? p.samples.map((s: any) => [asText(s && s[0]), asText(s && s[1])] as [string, string])
        : [];
    const zh = statements['zh-CN'] || statements.zh || statements['zh_CN'];
    return {
        pid: asText(p.pid) || pid,
        type: asText(p.type) || '',
        name: asText(zh?.name) || asText(p.name) || pid,
        difficulty: Number(p.difficulty) || 0,
        tags: Array.isArray(p.tags) ? p.tags.map(Number) : [],
        statements,
        samples,
        limits: {
            time: Number(p.limits?.time?.[0]) || 1000,
            memory: Number(p.limits?.memory?.[0]) || 262144,
        },
    };
}

export interface LuoguUserProfile {
    uid: string;
    uname: string;
    avatar: string;
    home: string;
    color?: string;
    slogan?: string;
    ranking?: number;
    passed?: number;
    submitted?: number;
}

/** 校验登录态：回传用户名与公开资料，任何错误都不包含 cookie 值 */
export async function verifyLogin(
    uid: string, clientId: string,
): Promise<{ uid: string; uname: string; profile: LuoguUserProfile }> {
    const u = String(uid || '').trim();
    const c = String(clientId || '').trim();
    if (!/^\d{1,12}$/.test(u)) throw new Error('缺少 _uid 或格式不正确（应为数字）');
    if (!c || c.length < 8) throw new Error('缺少 __client_id（客户端 ID）');
    const url = `${LUOGU}/user/${encodeURIComponent(u)}?_contentOnly=1`;
    let text: string;
    try {
        text = await fetchText(url, { cookie: `_uid=${u}; __client_id=${c}` });
    } catch (e) {
        throw new Error(`洛谷用户页请求失败：${e?.message || e}`);
    }
    const blocks: any[] = [];
    try {
        blocks.push(JSON.parse(text));
    } catch { /* 是 HTML，继续找 JSON 块 */ }
    blocks.push(...parseJsonBlocks(text));
    let uname = '';
    let userObj: any = null;
    for (const block of blocks) {
        const candidates = [
            block?.data?.user, block?.user, block?.currentUser,
            block?.data?.currentUser, block?.data,
        ];
        for (const user of candidates) {
            if (!user || typeof user !== 'object') continue;
            const name = user.name || user.uname || user.username;
            if (typeof name === 'string' && name.trim()) {
                uname = name.trim();
                userObj = user;
                break;
            }
        }
        if (uname) break;
    }
    if (!uname) throw new Error('未取到用户名：_uid / __client_id 无效或已过期，请重新从浏览器复制');
    const profile: LuoguUserProfile = {
        uid: String(userObj?.uid || u),
        uname,
        avatar: typeof userObj?.avatar === 'string' ? userObj.avatar : '',
        home: `${LUOGU}/user/${u}`,
        color: typeof userObj?.color === 'string' ? userObj.color : '',
        slogan: typeof userObj?.slogan === 'string' ? userObj.slogan : '',
        ranking: Number(userObj?.ranking) || undefined,
        passed: Number(userObj?.passedProblemCount) || undefined,
        submitted: Number(userObj?.submittedProblemCount) || undefined,
    };
    return { uid: u, uname, profile };
}

/**
 * 用 HEAD 探测题号是否存在（不拉题面正文，成本极低）。
 * 实测（带登录态）：存在的题 200，空号（如 P1172）401。
 */
export async function probeProblemExists(pid: string): Promise<boolean> {
    await throttle();
    const url = `${LUOGU}/problem/${encodeURIComponent(pid)}`;
    try {
        const res: any = await fetch(url, {
            method: 'HEAD',
            headers: {
                'User-Agent': UA,
                Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                Referer: LUOGU + '/problem/list',
                Cookie: cookieHeader(),
            },
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
        });
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (loc) return probeProblemExistsFollow(new URL(loc, url).toString(), 0);
        }
        return res.status === 200;
    } catch {
        return false;
    }
}

async function probeProblemExistsFollow(url: string, hop: number): Promise<boolean> {
    if (hop > 4) return false;
    try {
        const res: any = await fetch(url, {
            method: 'HEAD',
            headers: {
                'User-Agent': UA,
                Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
                Cookie: cookieHeader(),
            },
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
        });
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (loc) return probeProblemExistsFollow(new URL(loc, url).toString(), hop + 1);
        }
        return res.status === 200;
    } catch {
        return false;
    }
}

export interface LuoguListParams {
    page?: number;
    type?: string;
    keyword?: string;
    difficulty?: number[];
    tag?: number[];
}

export async function fetchProblemList(params: LuoguListParams) {
    const qs = new URLSearchParams();
    qs.set('type', params.type || 'P');
    qs.set('page', String(params.page || 1));
    if (params.keyword) qs.set('keyword', params.keyword);
    for (const d of params.difficulty || []) qs.append('difficulty', String(d));
    for (const t of params.tag || []) qs.append('tag', String(t));
    const html = await fetchText(`${LUOGU}/problem/list?${qs.toString()}`);
    const payload = parsePayload(html);
    const problems = payload.data.problems || {};
    return {
        count: Number(problems.count) || 0,
        perPage: Number(problems.perPage) || 50,
        result: Array.isArray(problems.result) ? problems.result : [],
    };
}

let tagCache: { at: number; data: Array<{ id: number; name: string }> } | null = null;

export async function fetchTags(): Promise<Array<{ id: number; name: string }>> {
    if (tagCache && Date.now() - tagCache.at < 3600_000) return tagCache.data;
    const text = await fetchText(`${LUOGU}/_lfe/tags`);
    let data: any;
    try {
        data = JSON.parse(text);
    } catch {
        const [block] = parseJsonBlocks(text);
        data = block || { tags: [] };
    }
    const tags = (data.tags || []).map((t: any) => ({ id: Number(t.id), name: asText(t.name) }))
        .filter((t: any) => t.name);
    tagCache = { at: Date.now(), data: tags };
    return tags;
}

/* ------------------------------------------------------------------ *
 * 远端提交：CSRF -> POST 提交 -> 验证码 -> 评测记录轮询
 * cookie 只放在请求头，绝不出现在错误文案或日志里。
 * ------------------------------------------------------------------ */

/** 洛谷要求图形验证码 */
export class CaptchaRequiredError extends Error {
    constructor(message = '需要输入图形验证码') {
        super(message);
        this.name = 'CaptchaRequiredError';
    }
}

interface RawInit {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    /** 本次请求使用的洛谷登录 cookie（按用户隔离，避免并发串号） */
    cookie?: string;
}

async function rawFetch(url: string, init: RawInit = {}) {
    await throttle();
    const headers: Record<string, string> = {
        'User-Agent': UA,
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...init.headers,
    };
    const cookie = cookieHeader(init.cookie);
    if (cookie) headers.Cookie = cookie;
    const res: any = await fetch(url, {
        method: init.method || 'GET',
        body: init.body,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
    });
    absorbCookies(res);
    return res;
}

/** /ranking 页面里的 <meta name="csrf-token">（首页会被反爬拦截，故用 ranking） */
export async function fetchCsrfToken(cookie?: string): Promise<string> {
    const html = await fetchText(`${LUOGU}/ranking`, { cookie });
    const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i)
        || html.match(/<meta\s+content="([^"]+)"\s+name="csrf-token"/i);
    if (!m || !m[1].trim()) throw new Error('CSRF token 获取失败（登录态可能已失效或被反爬拦截）');
    return m[1].trim();
}

/** 洛谷失败响应的错误消息可能嵌在任意层级（errorMessage / message / error / msg） */
function errorMessageOf(text: string): string {
    try {
        const stack: any[] = [JSON.parse(text)];
        const found: string[] = [];
        while (stack.length) {
            const cur = stack.pop();
            if (!cur || typeof cur !== 'object') continue;
            if (!Array.isArray(cur)) {
                for (const key of ['errorMessage', 'message', 'error', 'msg']) {
                    const v = cur[key];
                    if (typeof v === 'string' && v.trim() && !found.includes(v.trim())) found.push(v.trim());
                }
            }
            for (const v of Object.values(cur)) {
                if (v && typeof v === 'object') stack.push(v);
            }
        }
        return found.slice(0, 3).join(' / ');
    } catch {
        return '';
    }
}

/** 302 Location / JSON 任意层级 rid / 正文里的 /record/ 链接 */
function findRid(location: string, text: string): string | null {
    const re = /\/record\/(\d+)/;
    const fromLocation = location.match(re);
    if (fromLocation) return fromLocation[1];
    try {
        const stack: any[] = [JSON.parse(text)];
        while (stack.length) {
            const cur = stack.pop();
            if (!cur || typeof cur !== 'object') continue;
            if (!Array.isArray(cur)) {
                const rid = cur.rid;
                if (rid !== undefined && /^\d+$/.test(String(rid).trim())) return String(rid).trim();
            }
            stack.push(...Object.values(cur));
        }
    } catch { /* 不是 JSON */ }
    const fromText = text.match(re);
    return fromText ? fromText[1] : null;
}

export interface SubmitArgs {
    pid: string;
    code: string;
    lang: number;
    enableO2: boolean;
    captcha?: string;
    /** 当前用户的洛谷登录 cookie；不传则沿用全站拉题账号 */
    cookie?: string;
}

/** 提交代码，返回洛谷评测记录号 rid */
export async function submitCode(args: SubmitArgs): Promise<string> {
    const csrf = await fetchCsrfToken(args.cookie);
    const payload: Record<string, any> = {
        code: args.code,
        lang: args.lang,
        enableO2: !!args.enableO2,
    };
    if (args.captcha) payload.captcha = String(args.captcha).trim();
    const pid = encodeURIComponent(args.pid);
    const res = await rawFetch(`${LUOGU}/fe/api/problem/submit/${pid}`, {
        method: 'POST',
        body: JSON.stringify(payload),
        cookie: args.cookie,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-CSRF-Token': csrf,
            'X-Requested-With': 'XMLHttpRequest',
            Origin: LUOGU,
            Referer: `${LUOGU}/problem/${pid}`,
        },
    });
    const text = await res.text();
    const location = res.headers.get('location') || '';
    const rid = findRid(location, text);
    if (res.status >= 200 && res.status < 400 && rid) return rid;
    const message = errorMessageOf(text);
    // 实测洛谷要求图形码时不只返回 403：也可能 4xx 带 HTML、或 2xx 的 JSON 里只有 errorMessage。
    // 只要这次没拿到 rid 且响应里出现验证码关键词，就统一交给前端弹图，不再退化成一行「提交失败」。
    const captchaHint = /验证码|captcha|verify code/i.test(message)
        || (res.status >= 400 && /验证码|captcha|verify code/i.test(text.slice(0, 4000)));
    if (!rid && captchaHint) throw new CaptchaRequiredError(message || undefined);
    throw new Error(`提交失败：HTTP ${res.status}${message ? `，服务器返回：${message}` : ''}`
        + (rid ? '' : '（未解析到评测记录号，登录态可能已失效）'));
}

/** 验证码 PNG，返回可直接放进 <img src> 的 data URL；洛谷会先 302，需跟随 */
export async function fetchCaptchaImage(cookie?: string): Promise<string> {
    let current = `${LUOGU}/api/verify/captcha`;
    for (let hop = 0; hop < 6; hop++) {
        const res = await rawFetch(current, {
            cookie,
            headers: { Accept: 'image/png,image/*;q=0.9,*/*;q=0.8', Referer: `${LUOGU}/` },
        });
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) throw new Error('验证码图片跳转但没有跳转地址');
            current = new URL(loc, current).toString();
            continue;
        }
        if (res.status !== 200) throw new Error(`验证码图片获取失败：HTTP ${res.status}`);
        const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
        if (type && !type.startsWith('image/')) {
            throw new Error('验证码接口返回的不是图片（登录态可能已失效或被反爬拦截）');
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('验证码图片为空');
        return `data:${type || 'image/png'};base64,${buf.toString('base64')}`;
    }
    throw new Error('验证码图片跳转次数过多');
}

/** 拉取评测记录原始数据（由 submit.ts 的 formatRecord 整理） */
export async function fetchLuoguRecord(rid: string, cookie?: string): Promise<any> {
    if (!/^\d+$/.test(String(rid))) throw new Error('评测记录号格式不正确');
    const text = await fetchText(`${LUOGU}/record/${encodeURIComponent(rid)}?_contentOnly=1`, { cookie });
    const blocks: any[] = [];
    try {
        blocks.push(JSON.parse(text));
    } catch { /* 是 HTML */ }
    blocks.push(...parseJsonBlocks(text));
    for (const block of blocks) {
        if (block?.data?.record) return block.data.record;
        if (block?.record && typeof block.record === 'object') return block.record;
    }
    throw new Error('未取到评测记录数据（登录态可能已失效或该记录不可见）');
}
