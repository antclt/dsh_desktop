/**
 * 宿主侧 HTTP 面：设置页（客户端半）唯一的数据入口。
 *
 * 客户端半不复制任何迁移逻辑 —— 三个动作直接转调 `core/` 里的
 * inspect / migrate / verifyArtifact，配置以插件 config 为底、请求体只覆盖允许的字段。
 *
 * 安全：内核的 /api browser-trust 栅栏不覆盖自定义前缀路由，所以这里自己校验 Host
 * （只信 localhost / 127.0.0.1，与 synapse 同口径）—— 这条路由能往 `~/.dsh/sessions`
 * 写文件，不能让它被 DNS rebinding 打进来。
 */
import { inspect, migrate, readArtifact } from '../core/migrate.js'

/** 客户端半与宿主半共用的路由前缀（改这里要同步改 lib/client.js）。 */
export const API_PREFIX = '/zcode-migrate/api'

const TRUSTED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** 只接受已知字段，避免请求体把 dbPath/dshRoot 这类落点改掉。 */
function pickInspect(body) {
  return {
    cwd: typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : undefined,
    ids: Array.isArray(body.ids) && body.ids.length > 0 ? body.ids.map(String) : undefined,
    limit: Number.isFinite(body.limit) ? body.limit : undefined,
    since: Number.isFinite(body.since) ? body.since : undefined,
    until: Number.isFinite(body.until) ? body.until : undefined,
    includeSubagents: body.includeSubagents === true,
  }
}

function pickMigrate(body) {
  return {
    ...pickInspect(body),
    dryRun: body.dryRun === true,
    verify: body.verify !== false,
    includeReasoning: body.includeReasoning !== false,
    emitTitle: body.emitTitle !== false,
    agentPreset: typeof body.agentPreset === 'string' && body.agentPreset !== '' ? body.agentPreset : undefined,
  }
}

/**
 * Build the route handler for `ctx.webServer.register({ kind: 'prefix', … })`.
 * @param {object} resolved - the plugin's normalized config (dbPath/dshRoot/…).
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler(resolved) {
  return async (req, res) => {
    const hostname = (typeof req.headers?.host === 'string' ? req.headers.host : '')
      .replace(/:\d+$/, '')
      .toLowerCase()
    if (!TRUSTED_HOSTS.has(hostname)) return sendJson(res, 403, { ok: false, error: '不被信任的 Host' })

    const path = new URL(req.url ?? '/', 'http://dsh.local').pathname
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })

    try {
      if (path === `${API_PREFIX}/inspect`) {
        return sendJson(res, 200, await inspect({ ...resolved, ...pickInspect(await readJson(req)) }))
      }
      if (path === `${API_PREFIX}/migrate`) {
        return sendJson(res, 200, await migrate({ ...resolved, ...pickMigrate(await readJson(req)) }))
      }
      if (path === `${API_PREFIX}/verify`) {
        const body = await readJson(req)
        if (typeof body.path !== 'string' || body.path === '') {
          return sendJson(res, 400, { ok: false, error: 'verify 需要 path' })
        }
        // 用 readArtifact（纯回读）而不是 verifyArtifact：后者要「期望值」参数（CLI 逐条
        // 核对用），在设置页这种「这个产物还能不能读」的场景下会直接抛。
        // 文件缺失/损坏是**结果**不是服务端错误 —— 一律 200 + ok:false，页面照实显示。
        try {
          const artifact = readArtifact(body.path)
          return sendJson(res, 200, {
            ok: artifact.ok === true && artifact.tornStart === null,
            path: artifact.path,
            header: artifact.header ?? null,
            eventCount: artifact.eventCount,
            frameCount: artifact.frameCount,
            bytes: artifact.bytes,
            tornStart: artifact.tornStart ?? null,
          })
        } catch (err) {
          return sendJson(res, 200, { ok: false, path: body.path, error: err instanceof Error ? err.message : String(err) })
        }
      }
      return sendJson(res, 404, { ok: false, error: `未知接口：${path}` })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/**
 * Mount the API on the DSH web server (same lifetime as the plugin fiber).
 * @param {object} ctx - cordis context carrying `webServer` + `effect`.
 * @param {object} resolved - normalized plugin config.
 * @returns {boolean} whether the route was mounted.
 */
export function registerApi(ctx, resolved) {
  const webServer = ctx?.webServer
  if (typeof webServer?.register !== 'function') return false
  const handler = createApiHandler(resolved)
  const mount = () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
  if (typeof ctx.effect === 'function') ctx.effect(mount, 'zcode-migrate: api')
  else mount()
  return true
}
