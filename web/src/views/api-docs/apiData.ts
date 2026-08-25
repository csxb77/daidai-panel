export interface ApiParam {
  name: string
  type: string
  required?: boolean
  description: string
  example?: string
}

export interface ApiEndpoint {
  id: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  title: string
  description: string
  auth?: 'jwt' | 'open_api' | 'none' | 'ticket'
  pathParams?: ApiParam[]
  queryParams?: ApiParam[]
  bodyParams?: ApiParam[]
  helperExamples?: Record<string, string>
  responseExample?: string
  responseFields?: ApiParam[]
  responseContentType?: string
}

export interface ApiCategory {
  key: string
  label: string
  endpoints: ApiEndpoint[]
}

export const apiCategories: ApiCategory[] = [
  {
    key: 'plugin-guide',
    label: '插件对接指南',
    endpoints: [
      {
        id: 'plugin-overview',
        method: 'GET',
        path: '/docs/plugin-overview',
        title: '对接概述',
        description: '呆呆面板通过 Open API 应用机制对接第三方插件，实现环境变量的自动管理。首先在面板「Open API」页面创建应用，获取 App Key 和 App Secret。配置格式：Host丨AppKey丨AppSecret（使用中文竖线 丨 分隔），示例：http://127.0.0.1:5173丨a1b2c3d4...丨e5f6g7h8...。对接流程：1. 使用 App Key + App Secret 获取 Token → 2. 使用 Token 操作环境变量（增删改查）→ 3. Token 过期（24小时）后重新获取。',
        auth: 'none',
        responseExample: JSON.stringify({
          '配置格式': 'Host丨AppKey丨AppSecret',
          '配置示例': 'http://127.0.0.1:5173丨a1b2c3d4e5f6...丨e5f6g7h8i9j0...',
          '认证方式': 'Open API Token (Bearer)',
          '接口前缀': '/api/',
          'Token有效期': '24 小时，过期后重新调用 token 接口获取',
          '对接流程': [
            '1. 在面板「Open API」页面创建应用，获取 App Key 和 App Secret',
            '2. POST /api/open-api/token 获取 access_token',
            '3. GET /api/envs 查询环境变量',
            '4. POST /api/envs 添加环境变量',
            '5. PUT /api/envs/:id 更新环境变量',
            '6. DELETE /api/envs/:id 删除环境变量',
          ],
        }, null, 2),
        responseFields: [
          { name: 'Host', type: 'string', description: '呆呆面板地址，如 http://127.0.0.1:5173' },
          { name: 'AppKey', type: 'string', description: '应用的 App Key（在面板 Open API 页面创建应用后获取）' },
          { name: 'AppSecret', type: 'string', description: '应用的 App Secret（创建应用时生成）' },
          { name: 'Token', type: 'string', description: '通过 App Key + Secret 获取的 JWT Token，有效期 24 小时' },
        ],
      },
      {
        id: 'plugin-login',
        method: 'POST',
        path: '/api/open-api/token',
        title: '获取 Open API Token',
        description: '插件对接的第一步：使用在面板「Open API」页面创建的应用 App Key 和 App Secret 获取 access_token。Token 有效期 24 小时，过期后需重新调用此接口获取新 Token（无 refresh_token 机制）。',
        auth: 'none',
        bodyParams: [
          { name: 'app_key', type: 'string', required: true, description: '应用 App Key', example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' },
          { name: 'app_secret', type: 'string', required: true, description: '应用 App Secret', example: 'e5f6g7h8i9j0e5f6g7h8i9j0e5f6g7h8i9j0e5f6g7h8i9j0e5f6g7h8i9j0k1l2' },
        ],
        responseExample: JSON.stringify({
          data: {
            access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
            token_type: 'Bearer',
            expires_in: 86400,
          },
        }, null, 2),
        responseFields: [
          { name: 'data.access_token', type: 'string', description: 'JWT 访问令牌，有效期 24 小时，需携带在请求头 Authorization: Bearer {token}' },
          { name: 'data.token_type', type: 'string', description: '令牌类型，固定为 Bearer' },
          { name: 'data.expires_in', type: 'integer', description: '令牌有效期（秒），固定为 86400（24小时）' },
        ],
      },
      {
        id: 'plugin-find-env',
        method: 'GET',
        path: '/api/envs',
        title: '查找环境变量',
        description: '通过关键字搜索环境变量，用于判断变量是否已存在。插件通常通过 keyword 参数按变量名搜索，然后遍历结果匹配 remarks 中的用户标识来定位具体变量。',
        auth: 'jwt',
        queryParams: [
          { name: 'keyword', type: 'string', description: '搜索关键字（按变量名或备注模糊匹配）', example: 'sfsyUrl' },
          { name: 'page', type: 'integer', description: '页码，默认 1', example: '1' },
          { name: 'page_size', type: 'integer', description: '每页数量，建议设为 100 以获取完整列表', example: '100' },
        ],
        responseExample: JSON.stringify({
          data: [{
            id: 1,
            name: 'sfsyUrl',
            value: 'sessionId=xxx&_login_mobile_=xxx',
            remarks: '顺丰:账号1丨用户:123丨手机:138****1234丨到期:2026-12-31',
            created_at: '2026-03-13T10:00:00',
            updated_at: '2026-03-13T10:00:00',
          }],
          total: 1,
          page: 1,
          page_size: 100,
        }, null, 2),
        responseFields: [
          { name: 'data', type: 'array', description: '环境变量列表' },
          { name: 'data[].id', type: 'integer', description: '变量 ID，更新和删除时需要' },
          { name: 'data[].name', type: 'string', description: '变量名' },
          { name: 'data[].value', type: 'string', description: '变量值' },
          { name: 'data[].remarks', type: 'string', description: '备注，可存储用户标识等信息' },
          { name: 'total', type: 'integer', description: '总数' },
        ],
      },
      {
        id: 'plugin-add-env',
        method: 'POST',
        path: '/api/envs',
        title: '添加环境变量',
        description: '当查找不到已有变量时，调用此接口添加新的环境变量。注意：呆呆面板不需要对 value 进行 URL 编码，直接传递原始值即可。',
        auth: 'jwt',
        bodyParams: [
          { name: 'name', type: 'string', required: true, description: '变量名', example: 'sfsyUrl' },
          { name: 'value', type: 'string', required: true, description: '变量值（无需 URL 编码）', example: 'sessionId=xxx&_login_mobile_=xxx' },
          { name: 'remarks', type: 'string', description: '备注，建议存储用户标识信息', example: '顺丰:账号1丨用户:123丨手机:138****1234丨到期:2026-12-31' },
          { name: 'group', type: 'string', description: '分组名称', example: '顺丰' },
        ],
        responseExample: JSON.stringify({
          message: '创建成功',
          data: { id: 1, name: 'sfsyUrl', value: 'sessionId=xxx&_login_mobile_=xxx' },
        }, null, 2),
        responseFields: [
          { name: 'message', type: 'string', description: '操作结果消息' },
          { name: 'data', type: 'object', description: '创建的环境变量信息' },
          { name: 'data.id', type: 'integer', description: '新创建的变量 ID' },
        ],
      },
      {
        id: 'plugin-update-env',
        method: 'PUT',
        path: '/api/envs/:id',
        title: '更新环境变量',
        description: '当查找到已有变量时，调用此接口更新变量值。注意：ID 通过 URL 路径传递，不是放在请求体中。',
        auth: 'jwt',
        pathParams: [
          { name: 'id', type: 'integer', required: true, description: '环境变量 ID（通过查找接口获取）' },
        ],
        bodyParams: [
          { name: 'name', type: 'string', description: '变量名', example: 'sfsyUrl' },
          { name: 'value', type: 'string', description: '新的变量值', example: 'sessionId=new_value&_login_mobile_=new_mobile' },
          { name: 'remarks', type: 'string', description: '备注', example: '顺丰:账号1丨用户:123丨手机:138****1234丨到期:2026-12-31' },
          { name: 'group', type: 'string', description: '分组名称', example: '顺丰' },
        ],
        responseExample: JSON.stringify({ message: '更新成功' }, null, 2),
      },
      {
        id: 'plugin-delete-env',
        method: 'DELETE',
        path: '/api/envs/:id',
        title: '删除环境变量',
        description: '删除指定的环境变量。注意：呆呆面板通过路径参数传递 ID，不是请求体数组。',
        auth: 'jwt',
        pathParams: [
          { name: 'id', type: 'integer', required: true, description: '环境变量 ID' },
        ],
        responseExample: JSON.stringify({ message: '删除成功' }, null, 2),
      },
      {
        id: 'plugin-python-example',
        method: 'POST',
        path: '/api/open-api/token',
        title: 'Python 完整示例',
        description: '以下是完整的 Python 类封装 DaiDaiPanel，可直接在插件中使用。通过 Open API 的 App Key 和 App Secret 认证，支持查找/添加/更新/删除环境变量，以及智能的添加或更新逻辑。使用方法：panel = DaiDaiPanel(host, app_key, app_secret)，然后调用 panel.add_or_update_env(name, value, remarks, keyword) 即可自动判断添加或更新。',
        auth: 'none',
        bodyParams: [
          { name: 'host', type: 'string', required: true, description: '面板地址', example: 'http://127.0.0.1:5173' },
          { name: 'app_key', type: 'string', required: true, description: '应用 App Key', example: 'a1b2c3d4e5f6...' },
          { name: 'app_secret', type: 'string', required: true, description: '应用 App Secret', example: 'e5f6g7h8i9j0...' },
        ],
        responseExample: `# DaiDaiPanel 完整示例代码
import requests
from typing import Optional, Dict

class DaiDaiPanel:
    def __init__(self, host: str, app_key: str, app_secret: str):
        self.host = host.rstrip('/')
        self.app_key = app_key
        self.app_secret = app_secret
        self.access_token = None
        self._get_token()

    def _get_token(self):
        url = f'{self.host}/api/open-api/token'
        data = {"app_key": self.app_key, "app_secret": self.app_secret}
        res = requests.post(url, json=data, timeout=10)
        res.raise_for_status()
        result = res.json()
        self.access_token = result['data']['access_token']

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json"
        }

    def _request(self, method, url, **kwargs):
        res = getattr(requests, method)(url, headers=self._headers(), timeout=10, **kwargs)
        if res.status_code == 401:
            self._get_token()
            res = getattr(requests, method)(url, headers=self._headers(), timeout=10, **kwargs)
        return res

    def find_env(self, name: str, keyword: str = "") -> Optional[int]:
        url = f"{self.host}/api/envs?keyword={name}&page_size=100"
        res = self._request("get", url)
        for env in res.json().get('data', []):
            if env['name'] == name:
                if not keyword or keyword in env.get('remarks', ''):
                    return env['id']
        return None

    def add_env(self, name: str, value: str, remarks: str = "") -> bool:
        url = f"{self.host}/api/envs"
        data = {"name": name, "value": value, "remarks": remarks}
        res = self._request("post", url, json=data)
        return res.status_code == 200

    def update_env(self, env_id: int, name: str, value: str, remarks: str = "") -> bool:
        url = f"{self.host}/api/envs/{env_id}"
        data = {"name": name, "value": value, "remarks": remarks}
        res = self._request("put", url, json=data)
        return res.status_code == 200

    def delete_env(self, env_id: int) -> bool:
        url = f"{self.host}/api/envs/{env_id}"
        res = self._request("delete", url)
        return res.status_code == 200

    def add_or_update_env(self, name, value, remarks="", keyword=""):
        env_id = self.find_env(name, keyword)
        if env_id:
            return self.update_env(env_id, name, value, remarks)
        return self.add_env(name, value, remarks)

# 使用示例
panel = DaiDaiPanel(
    "http://127.0.0.1:5173",
    "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    "e5f6g7h8i9j0e5f6g7h8i9j0e5f6g7h8i9j0e5f6g7h8i9j0e5f6g7h8i9j0k1l2"
)
panel.add_or_update_env(
    name="sfsyUrl",
    value="sessionId=xxx&_login_mobile_=xxx",
    remarks="顺丰:账号1丨手机:138****1234丨到期:2026-12-31",
    keyword="账号1"
)`,
        responseFields: [
          { name: 'DaiDaiPanel(host, key, secret)', type: 'class', description: '初始化并通过 Open API 获取 Token' },
          { name: '_get_token()', type: 'method', description: '获取/刷新 Open API Token' },
          { name: '_request(method, url, ...)', type: 'method', description: '自动处理 401 重新获取 Token 的请求封装' },
          { name: 'find_env(name, keyword)', type: 'method', description: '查找环境变量，返回 ID 或 None' },
          { name: 'add_env(name, value, remarks)', type: 'method', description: '添加环境变量' },
          { name: 'update_env(id, name, value, remarks)', type: 'method', description: '更新环境变量' },
          { name: 'delete_env(id)', type: 'method', description: '删除环境变量' },
          { name: 'add_or_update_env(name, value, ...)', type: 'method', description: '智能添加或更新（推荐使用）' },
        ],
      },
      {
        id: 'plugin-notes',
        method: 'GET',
        path: '/docs/plugin-notes',
        title: '注意事项与常见问题',
        description: 'Token 管理：access_token 有效期 24 小时，过期后重新调用 POST /api/open-api/token 获取新 Token（无 refresh_token 机制）。在 Open API 的鉴权接口上收到 401 即表示 Token 过期，需重新获取。⚠️ 这条约定不适用于 POST /api/auth/login：登录接口的 401 还可能承载两步验证 / 人机验证挑战（响应体带 two_factor_required 或 captcha_required 及 code 字段），不能一律当成 Token 过期去续期，更不能在 401 时直接抛异常丢掉响应体。错误格式：{"error": "错误信息"} + HTTP 状态码（400/401/403/404/500），登录相关失败额外带机器可读的 code 字段。最佳实践：1. 不需要对 value 进行 URL 编码 2. 建议设置 10 秒超时 3. 建议对「已鉴权接口」实现 401 自动重新获取 Token，但登录接口要先读响应体再判断 4. 在 remarks 中存储用户标识便于查找 5. 查询时设置较大的 page_size（如 100）减少请求次数。',
        auth: 'none',
        responseExample: JSON.stringify({
          '差异对比': {
            '认证方式': '青龙: Client ID + Secret → 呆呆: App Key + App Secret',
            'Token获取': '青龙: GET /open/auth/token → 呆呆: POST /api/open-api/token',
            'Token有效期': '青龙: 不固定 → 呆呆: 24 小时',
            '添加变量': '青龙: POST /open/envs (数组) → 呆呆: POST /api/envs (对象)',
            '更新变量': '青龙: PUT /open/envs (body带id) → 呆呆: PUT /api/envs/{id} (路径参数)',
            '删除变量': '青龙: DELETE /open/envs (数组) → 呆呆: DELETE /api/envs/{id} (路径参数)',
            'Value编码': '青龙: 需要 URL 编码 → 呆呆: 不需要编码',
          },
          '错误响应格式': { error: '错误信息' },
          'HTTP状态码': {
            '200': '成功',
            '400': '参数错误',
            '401': '已鉴权接口：Token 过期或无效；/api/auth/login：凭据错误，或需要两步验证 / 人机验证（先读响应体的 code 字段）',
            '403': '应用已禁用',
            '404': '不存在',
            '429': '请求过于频繁，或账号已被锁定（code = account_locked）',
            '500': '服务器错误',
          },
        }, null, 2),
        responseFields: [
          { name: 'Token 过期', type: 'tip', description: '已鉴权接口收到 401 时，重新调用 POST /api/open-api/token 获取新 Token' },
          { name: '登录接口的 401', type: 'tip', description: 'POST /api/auth/login 的 401 不是 Token 过期。它可能是凭据错误，也可能是两步验证 / 人机验证挑战（two_factor_required / captcha_required）。请按响应体的 code 字段分支，不要在 401 时直接抛异常丢掉响应体' },
          { name: '应用禁用', type: 'tip', description: '收到 403 表示应用已被禁用，需在面板 Open API 页面重新启用' },
          { name: 'Value 编码', type: 'tip', description: '不需要 URL 编码，直接传原始值' },
          { name: '批量操作', type: 'tip', description: '暂不支持批量，需循环调用单个接口' },
          { name: '超时设置', type: 'tip', description: '建议所有请求设置 10 秒超时' },
          { name: '用户标识', type: 'tip', description: '在 remarks 中存储用户标识，查询时通过 keyword 过滤' },
        ],
      },
    ],
  },
  {
    key: 'auth',
    label: '认证',
    endpoints: [
      {
        id: 'auth-login',
        method: 'POST',
        path: '/api/auth/login',
        title: '用户登录',
        description: '使用用户名和密码登录，获取 JWT Token。⚠️ 本接口的 401 不等于「Token 过期」：账号开启两步验证或人机验证时，登录挑战同样用 401 承载，响应体里带 two_factor_required / captcha_required 与稳定的 code 字段。客户端必须先读响应体再决定下一步，不能把 401 一律当成需要续期而把响应体丢掉——若 HTTP 客户端（如 dio 的 validateStatus、axios 的 validateStatus）在 401 时直接抛异常，用户会看到「请输入两步验证码」却没有任何可输入的地方。收到 two_factor_required 时，请带上 totp_code 重发本接口；若同时带回 captcha_required=true，第二次请求还需重新完成人机验证。',
        auth: 'none',
        bodyParams: [
          { name: 'username', type: 'string', required: true, description: '用户名', example: 'admin' },
          { name: 'password', type: 'string', required: true, description: '密码', example: 'admin123' },
          { name: 'totp_code', type: 'string', required: false, description: '两步验证动态码（6 位）。仅在上一次请求返回 two_factor_required 时需要携带', example: '123456' },
          { name: 'captcha', type: 'object', required: false, description: '人机验证载荷（极验 4），字段：lot_number / captcha_output / pass_token / gen_time。仅在返回 captcha_required 时需要携带' },
        ],
        responseExample: JSON.stringify({
          '登录成功 (200)': {
            access_token: 'eyJhbGciOi...',
            refresh_token: 'eyJhbGciOi...',
            user: { id: 1, username: 'admin', role: 'admin' },
          },
          '需要两步验证码 (401)': {
            error: '请输入两步验证码',
            code: 'two_factor_required',
            two_factor_required: true,
            captcha_required: false,
            captcha_id: '',
            captcha_threshold: 0,
            require_after_failures: 0,
          },
          '两步验证码错误 (401)': {
            error: '两步验证码错误',
            code: 'invalid_totp',
            two_factor_required: true,
          },
          '用户名或密码错误 (401)': {
            error: '用户名或密码错误',
            code: 'invalid_credentials',
            failed_attempts: 1,
          },
          '账号已锁定 (429)': {
            error: '账号已锁定，请 15 分钟后重试',
            code: 'account_locked',
            locked: true,
            remaining_seconds: 900,
          },
        }, null, 2),
        responseFields: [
          { name: 'access_token', type: 'string', description: 'JWT 访问令牌（仅登录成功时返回）' },
          { name: 'refresh_token', type: 'string', description: 'JWT 刷新令牌（仅登录成功时返回）' },
          { name: 'user', type: 'object', description: '用户信息（仅登录成功时返回）' },
          { name: 'code', type: 'string', description: '登录失败的稳定机器可读标识，取值：two_factor_required / invalid_totp / invalid_credentials / captcha_required / account_locked。建议客户端按 code 分支，不要匹配中文文案' },
          { name: 'error', type: 'string', description: '失败原因的中文提示，可直接展示给用户' },
          { name: 'two_factor_required', type: 'boolean', description: '为 true 表示需要两步验证码，请带 totp_code 重发本接口' },
          { name: 'captcha_required', type: 'boolean', description: '为 true 表示本次登录需要完成人机验证；两步验证挑战同样会回带该字段' },
          { name: 'captcha_id', type: 'string', description: '极验 4 的 Captcha ID，前端初始化验证码组件时使用' },
          { name: 'require_after_failures', type: 'number', description: '触发人机验证所需的失败次数，0 表示每次登录都需要' },
          { name: 'failed_attempts', type: 'number', description: '当前 IP + 用户名累计的连续失败次数' },
        ],
      },
      {
        id: 'auth-refresh',
        method: 'POST',
        path: '/api/auth/refresh',
        title: '刷新令牌',
        description: '使用 refresh_token 获取新的 access_token',
        auth: 'jwt',
        responseExample: JSON.stringify({ access_token: 'eyJhbGciOi...' }, null, 2),
      },
      {
        id: 'auth-me',
        method: 'GET',
        path: '/api/auth/user',
        title: '获取当前用户信息',
        description: '获取当前登录用户的详细信息',
        auth: 'jwt',
        responseExample: JSON.stringify({
          user: { id: 1, username: 'admin', role: 'admin', enabled: true, created_at: '2026-01-01T00:00:00' },
        }, null, 2),
      },
      {
        id: 'auth-password',
        method: 'PUT',
        path: '/api/auth/password',
        title: '修改密码',
        description: '修改当前用户密码',
        auth: 'jwt',
        bodyParams: [
          { name: 'old_password', type: 'string', required: true, description: '当前密码' },
          { name: 'new_password', type: 'string', required: true, description: '新密码（至少8位）' },
        ],
        responseExample: JSON.stringify({ message: '密码修改成功' }, null, 2),
      },
      {
        id: 'auth-2fa-status',
        method: 'GET',
        path: '/api/security/2fa/status',
        title: '查询两步验证状态',
        description: '查询当前登录用户是否已启用两步验证（TOTP）',
        auth: 'jwt',
        responseExample: JSON.stringify({ data: { enabled: true } }, null, 2),
        responseFields: [
          { name: 'data.enabled', type: 'boolean', description: '是否已启用两步验证' },
        ],
      },
      {
        id: 'auth-2fa-setup',
        method: 'POST',
        path: '/api/security/2fa/setup',
        title: '生成两步验证密钥',
        description: '为当前登录用户生成新的 TOTP 密钥并返回 otpauth 链接。此时两步验证仍处于「未启用」状态，需要再调用 /api/security/2fa/verify 输入动态码确认后才真正生效。重复调用会覆盖上一次尚未确认的密钥。',
        auth: 'jwt',
        responseExample: JSON.stringify({
          data: {
            secret: 'JBSWY3DPEHPK3PXP',
            uri: 'otpauth://totp/DaiDaiPanel:admin?secret=JBSWY3DPEHPK3PXP&issuer=DaiDaiPanel&digits=6&period=30',
          },
        }, null, 2),
        responseFields: [
          { name: 'data.secret', type: 'string', description: 'Base32 编码的 TOTP 密钥，可手动录入验证器 App' },
          { name: 'data.uri', type: 'string', description: 'otpauth 链接，用于生成二维码；6 位动态码、30 秒周期' },
        ],
      },
      {
        id: 'auth-2fa-verify',
        method: 'POST',
        path: '/api/security/2fa/verify',
        title: '确认并启用两步验证',
        description: '输入验证器 App 当前显示的动态码，确认密钥已正确录入后启用两步验证。启用后再次登录会先收到 401 + two_factor_required 挑战。',
        auth: 'jwt',
        bodyParams: [
          { name: 'code', type: 'string', required: true, description: '验证器当前显示的 6 位动态码', example: '123456' },
        ],
        responseExample: JSON.stringify({ message: '2FA 已启用' }, null, 2),
      },
      {
        id: 'auth-2fa-disable',
        method: 'DELETE',
        path: '/api/security/2fa',
        title: '关闭两步验证',
        description: '关闭当前登录用户的两步验证。必须提供当前动态码——仅凭一个被劫持的会话不足以摘掉两步验证。若验证器已丢失，可在服务器上执行 ddp disable-2fa <用户名> 兜底。',
        auth: 'jwt',
        bodyParams: [
          { name: 'code', type: 'string', required: true, description: '验证器当前显示的 6 位动态码', example: '123456' },
        ],
        responseExample: JSON.stringify({ message: '2FA 已禁用' }, null, 2),
      },
    ],
  },
  {
    key: 'tasks',
    label: '定时任务',
    endpoints: [
      {
        id: 'tasks-list',
        method: 'GET',
        path: '/api/tasks',
        title: '获取任务列表',
        description: '获取所有定时任务，支持关键字搜索和分页',
        auth: 'jwt',
        queryParams: [
          { name: 'keyword', type: 'string', description: '搜索关键字' },
          { name: 'page', type: 'integer', description: '页码，默认 1', example: '1' },
          { name: 'page_size', type: 'integer', description: '每页数量，默认 20', example: '20' },
        ],
        responseExample: JSON.stringify({
          data: [{
            id: 1,
            name: '签到任务',
            command: 'task sign.py',
            cron_expression: '0 9 * * *',
            status: 1,
            last_run_status: 0,
            last_run_at: '2026-03-10T09:00:00',
            notify_on_abort: false,
            notification_channel_id: 3,
            notification_channel_name: 'Telegram 主通道',
          }],
          total: 1, page: 1, page_size: 20,
        }, null, 2),
      },
      {
        id: 'tasks-create',
        method: 'POST',
        path: '/api/tasks',
        title: '创建任务',
        description: '创建新的定时任务',
        auth: 'jwt',
        bodyParams: [
          { name: 'name', type: 'string', required: true, description: '任务名称', example: '签到任务' },
          { name: 'command', type: 'string', required: true, description: '执行命令', example: 'task sign.py' },
          { name: 'task_type', type: 'string', description: '任务类型：cron / manual / startup', example: 'cron' },
          { name: 'cron_expression', type: 'string', description: 'Cron 表达式；task_type=cron 时必填', example: '0 9 * * *' },
          { name: 'timeout', type: 'integer', description: '超时时间（秒），0 表示永不超时', example: '0' },
          { name: 'max_retries', type: 'integer', description: '最大重试次数', example: '0' },
          { name: 'retry_interval', type: 'integer', description: '重试间隔（秒）', example: '5' },
          { name: 'notify_on_failure', type: 'boolean', description: '失败时通知', example: 'true' },
          { name: 'notify_on_success', type: 'boolean', description: '成功时通知', example: 'false' },
          { name: 'notify_on_abort', type: 'boolean', description: '主动终止时通知', example: 'false' },
          { name: 'notification_channel_id', type: 'integer', description: '指定通知渠道 ID，留空则发送到全部「默认推送」渠道（push_scope=default）', example: '3' },
        ],
        responseExample: JSON.stringify({ message: '创建成功', data: { id: 1, name: '签到任务' } }, null, 2),
      },
      {
        id: 'tasks-update',
        method: 'PUT',
        path: '/api/tasks/:id',
        title: '更新任务',
        description: '更新指定任务的配置',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '任务 ID' }],
        bodyParams: [
          { name: 'name', type: 'string', description: '任务名称' },
          { name: 'command', type: 'string', description: '执行命令' },
          { name: 'task_type', type: 'string', description: '任务类型：cron / manual / startup' },
          { name: 'cron_expression', type: 'string', description: 'Cron 表达式' },
          { name: 'timeout', type: 'integer', description: '超时时间（秒），0 表示永不超时' },
          { name: 'max_retries', type: 'integer', description: '最大重试次数' },
          { name: 'retry_interval', type: 'integer', description: '重试间隔（秒）' },
          { name: 'notify_on_failure', type: 'boolean', description: '失败时通知' },
          { name: 'notify_on_success', type: 'boolean', description: '成功时通知' },
          { name: 'notify_on_abort', type: 'boolean', description: '主动终止时通知' },
          { name: 'notification_channel_id', type: 'integer', description: '指定通知渠道 ID，设为 null 则恢复为发送到全部「默认推送」渠道' },
        ],
        responseExample: JSON.stringify({ message: '更新成功' }, null, 2),
      },
      {
        id: 'tasks-delete',
        method: 'DELETE',
        path: '/api/tasks/:id',
        title: '删除任务',
        description: '删除指定任务',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '任务 ID' }],
        responseExample: JSON.stringify({ message: '删除成功' }, null, 2),
      },
      {
        id: 'tasks-run',
        method: 'PUT',
        path: '/api/tasks/:id/run',
        title: '立即执行任务',
        description: '立即触发执行指定任务',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '任务 ID' }],
        responseExample: JSON.stringify({ message: '任务已开始执行' }, null, 2),
      },
      {
        id: 'tasks-stop',
        method: 'PUT',
        path: '/api/tasks/:id/stop',
        title: '停止任务',
        description: '停止正在执行的任务',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '任务 ID' }],
        responseExample: JSON.stringify({ message: '任务已停止' }, null, 2),
      },
    ],
  },
  {
    key: 'logs',
    label: '执行日志',
    endpoints: [
      {
        id: 'logs-list',
        method: 'GET',
        path: '/api/logs',
        title: '获取日志列表',
        description: '获取任务执行日志，支持按任务、状态过滤和分页',
        auth: 'jwt',
        queryParams: [
          { name: 'task_id', type: 'integer', description: '按任务 ID 过滤', example: '1' },
          { name: 'status', type: 'integer', description: '状态过滤：0=成功, 1=失败, 2=运行中, 3=已终止' },
          { name: 'keyword', type: 'string', description: '按任务名称模糊匹配（子串包含，不是通配符）', example: '签到' },
          { name: 'page', type: 'integer', description: '页码', example: '1' },
          { name: 'page_size', type: 'integer', description: '每页数量，最大 100，超出或非法时按 20 处理', example: '20' },
        ],
        responseExample: JSON.stringify({
          data: [{ id: 1, task_id: 1, task_name: '签到任务', status: 0, content: '执行成功', duration: 2.5, started_at: '2026-03-10T09:00:00' }],
          total: 1,
          page: 1,
          page_size: 20,
        }, null, 2),
      },
      {
        id: 'logs-detail',
        method: 'GET',
        path: '/api/logs/:id',
        title: '获取日志详情',
        description: '获取单条日志的详细内容。content 返回的是按终端语义折叠过裸 \\r（回车覆盖）之后的文本，进度条之类的刷新输出会被折叠成最终一帧；需要磁盘上一模一样的原始字节，请改用下面的「原始日志下载」两步接口。log_path 为该日志在日志目录内的相对路径，为 null 表示这条日志的内容只存在数据库里、没有独立的日志文件。',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '日志 ID' }],
        responseExample: JSON.stringify({
          id: 1, task_id: 1, task_name: '签到任务', status: 0, content: '签到成功\n获得 10 积分', duration: 2.5, log_path: 'task_1_签到/2026-03-10-09-00-00.log', started_at: '2026-03-10T09:00:00', ended_at: '2026-03-10T09:00:02',
        }, null, 2),
      },
      {
        id: 'logs-raw-ticket',
        method: 'GET',
        path: '/api/logs/:id/raw-ticket',
        title: '签发原始日志下载票据',
        description: '下载原始日志分两步，这是第一步「换票」，不能跳过它直接调 /raw。面板其它日志接口给出的都是按终端语义折叠过裸 \\r 的文本，只有这条链路能拿到磁盘文件的原始字节（含未被折叠的终端控制序列）。本接口的鉴权与 GET /api/logs/:id 完全一致：走正常的 Authorization: Bearer（用户 JWT 或带 logs 权限的 Open API Token，viewer 及以上角色）。校验通过并在磁盘上定位到文件后，签发一张有效期 120 秒、且只对这一条日志生效的票据，返回体里的 url 已经把 ticket 拼好，是一个相对路径，直接接在面板地址后面即可，不要自行改写其中的参数。失败情况：日志 ID 不是数字返回 400「无效的日志ID」；日志记录不存在返回 404「日志不存在」；日志内容只存在数据库里（log_path 为空，这类记录的内容会被压缩后直接写进 content 字段）时没有原始文件可下，返回 404「该日志没有独立的原始日志文件（内容仅存于数据库）」；文件已被清理或路径异常返回 404「原始日志文件不存在或已被清理」；签名失败返回 500「签发下载票据失败」。错误响应体统一为 {"error": "..."}。',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '日志 ID' }],
        responseExample: JSON.stringify({
          url: '/api/logs/12/raw?ticket=v1.YWRtaW4.1785000120.3Qk8x1r0Zq2m9v7bN4pS6cW8dY0aE2gH5jK7lM9nQ1s',
          filename: '签到任务-12-raw.log',
          size: 20480,
          expires_at: '2026-08-04T12:02:00+08:00',
          expires_in: 120,
        }, null, 2),
        responseFields: [
          { name: 'url', type: 'string', description: '已拼好票据的下载地址（相对路径），直接接在面板地址后访问即可；请整段照用，改写任何参数都会导致验签失败' },
          { name: 'filename', type: 'string', description: '建议保存的文件名，格式为 <任务名>-<日志ID>-raw.log；-raw 后缀用于和前端「折叠后」的下载区分' },
          { name: 'size', type: 'integer', description: '磁盘文件字节数' },
          { name: 'expires_at', type: 'string', description: '票据过期时间（RFC3339）' },
          { name: 'expires_in', type: 'integer', description: '票据有效期（秒），当前为 120' },
        ],
      },
      {
        id: 'logs-raw',
        method: 'GET',
        path: '/api/logs/:id/raw',
        title: '下载原始日志文件',
        description: '下载原始日志的第二步：凭票据直传文件。这条路由刻意没有挂 JWT 中间件，只认 URL 上的 ticket —— 因为浏览器原生下载（<a download> / window.open）带不上 Authorization 头；反过来也成立：只带 Bearer 而不带 ticket 一样会被拒（401「缺少下载票据」）。票据由上一步的 raw-ticket 签发，HMAC 签名里绑定了具体的日志 ID，挪到另一条日志上用会 401「下载票据无效」；超过 120 秒返回 401「下载票据已过期，请重新发起下载」。票据不落库、不是一次性的，有效期内可重复使用，且只在请求开始时校验一次，传输本身持续多久都不受影响（浏览器断线重试 / Range 续传因此不会失败）。响应是文件流而不是 JSON：Content-Type 为 text/plain; charset=utf-8，服务端按 32KB 分块直传不整体读进内存，并支持 Range 续传；Content-Disposition 同时给出 ASCII 回退名 filename="..." 和 RFC 5987 的 filename*=UTF-8\'\'...（中文文件名不会乱码）。日志被清理时返回 404「原始日志文件不存在或已被清理」。',
        auth: 'ticket',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '日志 ID，必须与换票时的一致' }],
        queryParams: [
          { name: 'ticket', type: 'string', required: true, description: '上一步 raw-ticket 签发的票据（已包含在返回的 url 里，正常无需手动拼）', example: 'v1.YWRtaW4.1785000120.3Qk8...' },
        ],
        responseContentType: 'text/plain; charset=utf-8（文件流）',
        responseExample: `HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Content-Length: 20480
Content-Disposition: attachment; filename="____-12-raw.log"; filename*=UTF-8''%E7%AD%BE%E5%88%B0%E4%BB%BB%E5%8A%A1-12-raw.log
Accept-Ranges: bytes
Cache-Control: no-store, no-cache, must-revalidate
X-Content-Type-Options: nosniff

<磁盘日志文件的原始字节，保留裸 \\r 等终端控制序列，未做任何折叠处理>`,
      },
      {
        id: 'tasks-log-file-raw-ticket',
        method: 'GET',
        path: '/api/tasks/:id/log-files/:filename/raw-ticket',
        title: '签发任务日志文件下载票据',
        description: '任务日志文件（任务详情里「日志文件」列表中的 .log）原始内容下载的第一步：换票，同样不能跳过它直接调 /raw。鉴权与 GET /api/tasks/:id/log-files/:filename 完全一致（Authorization: Bearer + viewer 及以上角色）。文件定位口径也与日志文件预览 / 删除 / 下载一致：优先取查询参数 path（日志目录内的相对路径），没传或为空时回落到路径参数 filename。票据有效期 120 秒，并绑定「任务 ID + 本次传入的定位参数」，换不到别的任务或别的文件上去用。签发时传了 path，返回的 url 会把它原样带回，请整段照用、不要自己拼。失败情况：任务 ID 不是数字返回 400「无效的任务ID」；文件不存在、首段目录不是该任务的 task_<id>[_label] 目录、或存在路径穿越（../、绝对路径、软链逃逸）一律返回 404「原始日志文件不存在或已被清理」；签名失败返回 500「签发下载票据失败」。',
        auth: 'jwt',
        pathParams: [
          { name: 'id', type: 'integer', required: true, description: '任务 ID' },
          { name: 'filename', type: 'string', required: true, description: '日志文件名，需 URL 编码；传了 path 时它只作占位', example: '2026-03-10-09-00-00.log' },
        ],
        queryParams: [
          { name: 'path', type: 'string', description: '日志目录内的相对路径，首段必须是该任务的 task_<id>[_label] 目录；同名文件分散在多个任务目录时用它精确定位', example: 'task_1_签到/2026-03-10-09-00-00.log' },
        ],
        responseExample: JSON.stringify({
          url: '/api/tasks/1/log-files/2026-03-10-09-00-00.log/raw?path=task_1_%E7%AD%BE%E5%88%B0%2F2026-03-10-09-00-00.log&ticket=v1.YWRtaW4.1785000120.3Qk8x1r0Zq2m9v7bN4pS6cW8dY0aE2gH5jK7lM9nQ1s',
          filename: '2026-03-10-09-00-00.log',
          size: 20480,
          expires_at: '2026-08-04T12:02:00+08:00',
          expires_in: 120,
        }, null, 2),
        responseFields: [
          { name: 'url', type: 'string', description: '已拼好 path 与 ticket 的下载地址（相对路径）；path 必须与换票时完全一致，所以请整段照用' },
          { name: 'filename', type: 'string', description: '建议保存的文件名，取相对路径的最后一段' },
          { name: 'size', type: 'integer', description: '磁盘文件字节数' },
          { name: 'expires_at', type: 'string', description: '票据过期时间（RFC3339）' },
          { name: 'expires_in', type: 'integer', description: '票据有效期（秒），当前为 120' },
        ],
      },
      {
        id: 'tasks-log-file-raw',
        method: 'GET',
        path: '/api/tasks/:id/log-files/:filename/raw',
        title: '下载任务日志文件原始内容',
        description: '任务日志文件原始内容下载的第二步：凭票据直传。与 /logs/:id/raw 一样，这条路由没有挂 JWT 中间件、只认 URL 上的 ticket，带 Bearer 而不带 ticket 会被拒（401「缺少下载票据」）。票据绑定的是「任务 ID + 原样的定位参数」，所以 path 必须和换票时一模一样（直接用返回的 url 最稳）：改了 path、换了任务、或者试图用 ../ 穿越，都会先在验签这一关被拒（401「下载票据无效」），根本碰不到磁盘；票据过期返回 401「下载票据已过期，请重新发起下载」。有效期内票据可重复使用，只在请求开始时校验一次。响应是文件流而不是 JSON：Content-Type 为 text/plain; charset=utf-8，支持 Range 续传，Content-Disposition 同时给出 ASCII 回退名和 RFC 5987 的 filename*=UTF-8\'\'...；文件内容保留裸 \\r 等终端控制序列，不做任何折叠。文件已被清理时返回 404「原始日志文件不存在或已被清理」。',
        auth: 'ticket',
        pathParams: [
          { name: 'id', type: 'integer', required: true, description: '任务 ID，必须与换票时的一致' },
          { name: 'filename', type: 'string', required: true, description: '日志文件名（URL 编码）；传了 path 时它只作占位' },
        ],
        queryParams: [
          { name: 'ticket', type: 'string', required: true, description: '上一步 raw-ticket 签发的票据（已包含在返回的 url 里）', example: 'v1.YWRtaW4.1785000120.3Qk8...' },
          { name: 'path', type: 'string', description: '必须与换票时传入的值完全一致，否则验签失败；换票时没传就不要传', example: 'task_1_签到/2026-03-10-09-00-00.log' },
        ],
        responseContentType: 'text/plain; charset=utf-8（文件流）',
        responseExample: `HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Content-Length: 20480
Content-Disposition: attachment; filename="2026-03-10-09-00-00.log"; filename*=UTF-8''2026-03-10-09-00-00.log
Accept-Ranges: bytes
Cache-Control: no-store, no-cache, must-revalidate
X-Content-Type-Options: nosniff

<磁盘日志文件的原始字节，保留裸 \\r 等终端控制序列，未做任何折叠处理>`,
      },
      {
        id: 'tasks-log-archive-ticket',
        method: 'GET',
        path: '/api/tasks/:id/log-files/archive-ticket',
        title: '签发任务日志打包下载票据',
        description: '把一个任务的日志文件夹一次性打成 zip 下载，分两步，这是第一步「换票」。适用于「一个每 5 分钟跑一次的任务，7 天有 2000+ 个日志文件，逐个下载点不完」的场景。待打包的文件清单直接复用 GET /api/tasks/:id/log-files 那份数据，所以「下载到的 = 列表里看到的」。本接口的鉴权与其它日志文件接口完全一致：Authorization: Bearer（用户 JWT 或带 tasks 权限的 Open API Token，viewer 及以上角色）。收集与上限校验全部在签票时完成（zip 一旦开始写就没法回退成 JSON 错误），返回体里的 url 已经把 ticket 与 start/end 拼好，是一个相对路径，直接接在面板地址后面即可，不要自行改写其中的参数 —— start/end 参与票据签名，改任何一个都会导致下载时 401。失败情况：任务 ID 不是数字返回 400「无效的任务ID」；该任务（在给定时间范围内）一个日志文件都没有返回 404「该任务暂无日志文件」；超过 2000 个文件或未压缩总量超过 512MB 返回 400，文案里会带上实际数量与体积并提示改用更小的时间范围；签名失败返回 500「签发下载票据失败」。错误响应体统一为 {"error": "..."}。',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '任务 ID' }],
        queryParams: [
          { name: 'start', type: 'string', description: '起始时间（RFC3339），按日志文件的磁盘修改时间筛选，也就是日志文件列表里 created_at 那一列；不传表示不限起点', example: '2026-03-04T00:00:00+08:00' },
          { name: 'end', type: 'string', description: '结束时间（RFC3339），闭区间；不传表示不限终点。手写 URL 时请把时区里的 + 编码成 %2B，否则会被解析成空格（服务端有容错，但不要依赖）', example: '2026-03-10T23:59:59+08:00' },
        ],
        responseExample: JSON.stringify({
          url: '/api/tasks/1/log-files/archive?end=2026-03-10T23%3A59%3A59%2B08%3A00&start=2026-03-04T00%3A00%3A00%2B08%3A00&ticket=v1.YWRtaW4.1785000120.3Qk8x1r0Zq2m9v7bN4pS6cW8dY0aE2gH5jK7lM9nQ1s',
          filename: '签到任务-logs-20260310.zip',
          size: 20971520,
          file_count: 168,
          expires_at: '2026-08-04T12:02:00+08:00',
          expires_in: 120,
        }, null, 2),
        responseFields: [
          { name: 'url', type: 'string', description: '已拼好 start / end / ticket 的下载地址（相对路径）；三个参数都参与验签，请整段照用' },
          { name: 'filename', type: 'string', description: '建议保存的文件名，格式为 <任务名>-logs-<YYYYMMDD>.zip' },
          { name: 'size', type: 'integer', description: '本次要打包的【未压缩】总字节数。流式 zip 事先算不出压缩后大小，所以这不是响应体长度' },
          { name: 'file_count', type: 'integer', description: '本次要打包的文件个数' },
          { name: 'expires_at', type: 'string', description: '票据过期时间（RFC3339）' },
          { name: 'expires_in', type: 'integer', description: '票据有效期（秒），当前为 120' },
        ],
      },
      {
        id: 'tasks-log-archive',
        method: 'GET',
        path: '/api/tasks/:id/log-files/archive',
        title: '下载任务日志压缩包',
        description: '打包下载的第二步：凭票据直传 zip。这条路由刻意没有挂 JWT 中间件，只认 URL 上的 ticket —— 因为浏览器原生下载带不上 Authorization 头；反过来也成立：只带 Bearer 而不带 ticket 一样会被拒（401「缺少下载票据」）。票据的 HMAC 签名里绑定了任务 ID 与原样的 start/end，挪到另一个任务或改动时间范围都会 401「下载票据无效」；超过 120 秒返回 401「下载票据已过期，请重新发起下载」。验票通过后会把文件清单与上限校验完整重跑一遍（票据有效期内文件可能已被日志清理删掉），再开始写 zip。zip 内的路径就是日志根目录内的相对路径（形如 task_1_签到/2026-03-10-09-00-00.log），任务改过名留下多个 task_<id>_<名字> 目录时层级会完整保留、不会撞名；文件内容是磁盘原始字节，未做任何折叠处理。响应是边压边发的流：没有 Content-Length，也【不支持 Range 断点续传】（不会返回 Accept-Ranges），断线只能整包重来。Content-Disposition 同时给出 ASCII 回退名 filename="..." 和 RFC 5987 的 filename*=UTF-8\'\'...（中文任务名不会乱码）。',
        auth: 'ticket',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '任务 ID，必须与换票时的一致' }],
        queryParams: [
          { name: 'ticket', type: 'string', required: true, description: '上一步 archive-ticket 签发的票据（已包含在返回的 url 里，正常无需手动拼）', example: 'v1.YWRtaW4.1785000120.3Qk8...' },
          { name: 'start', type: 'string', description: '必须与换票时传入的值完全一致，否则验签失败；换票时没传就不要传', example: '2026-03-04T00:00:00+08:00' },
          { name: 'end', type: 'string', description: '必须与换票时传入的值完全一致，否则验签失败；换票时没传就不要传', example: '2026-03-10T23:59:59+08:00' },
        ],
        responseContentType: 'application/zip（流式压缩包）',
        responseExample: `HTTP/1.1 200 OK
Content-Type: application/zip
Content-Disposition: attachment; filename="____-logs-20260310.zip"; filename*=UTF-8''%E7%AD%BE%E5%88%B0%E4%BB%BB%E5%8A%A1-logs-20260310.zip
Cache-Control: no-store
X-Content-Type-Options: nosniff
Transfer-Encoding: chunked

<zip 字节流；每个 entry 的路径为 task_<id>[_<任务名>]/<文件名>.log，内容与磁盘完全一致>`,
      },
      {
        id: 'logs-delete',
        method: 'DELETE',
        path: '/api/logs/:id',
        title: '删除日志',
        description: '删除指定日志记录。日志不存在时返回 404「日志不存在」',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '日志 ID' }],
        responseExample: JSON.stringify({ message: '日志已删除' }, null, 2),
      },
    ],
  },
  {
    key: 'scripts',
    label: '脚本管理',
    endpoints: [
      {
        id: 'scripts-list',
        method: 'GET',
        path: '/api/scripts',
        title: '获取脚本列表',
        description: '获取所有脚本文件列表',
        auth: 'jwt',
        responseExample: JSON.stringify({ data: [{ path: 'sign.py', size: 1024, modified: '2026-03-10T00:00:00' }] }, null, 2),
      },
      {
        id: 'scripts-content',
        method: 'GET',
        path: '/api/scripts/content?path=:path',
        title: '获取脚本内容',
        description: '获取指定脚本的文件内容',
        auth: 'jwt',
        queryParams: [{ name: 'path', type: 'string', required: true, description: '脚本路径', example: 'sign.py' }],
        responseExample: JSON.stringify({ data: { path: 'sign.py', content: 'print("hello")', binary: false, is_binary: false } }, null, 2),
      },
      {
        id: 'scripts-save',
        method: 'PUT',
        path: '/api/scripts/content',
        title: '保存脚本内容',
        description: '创建或更新脚本文件',
        auth: 'jwt',
        bodyParams: [
          { name: 'path', type: 'string', required: true, description: '脚本路径' },
          { name: 'content', type: 'string', required: true, description: '脚本内容' },
        ],
        responseExample: JSON.stringify({ message: '保存成功' }, null, 2),
      },
      {
        id: 'scripts-delete',
        method: 'DELETE',
        path: '/api/scripts/:path',
        title: '删除脚本',
        description: '删除指定脚本文件',
        auth: 'jwt',
        pathParams: [{ name: 'path', type: 'string', required: true, description: '脚本路径' }],
        responseExample: JSON.stringify({ message: '删除成功' }, null, 2),
      },
      {
        id: 'scripts-upload',
        method: 'POST',
        path: '/api/scripts/upload',
        title: '上传脚本',
        description: '上传脚本文件，支持 .py/.js/.sh/.ts',
        auth: 'jwt',
        bodyParams: [{ name: 'file', type: 'file', required: true, description: '脚本文件（multipart/form-data）' }],
        responseExample: JSON.stringify({ message: '上传成功', data: { path: 'sign.py' } }, null, 2),
      },
    ],
  },
  {
    key: 'envs',
    label: '环境变量',
    endpoints: [
      {
        id: 'envs-list',
        method: 'GET',
        path: '/api/envs',
        title: '获取所有环境变量',
        description: '获取环境变量列表，支持搜索和分页；带 all=1 时一次返回全部（硬上限 5000）',
        auth: 'jwt',
        queryParams: [
          { name: 'keyword', type: 'string', description: '搜索关键字' },
          { name: 'page', type: 'integer', description: '页码', example: '1' },
          { name: 'page_size', type: 'integer', description: '每页数量', example: '20' },
          { name: 'all', type: 'integer', description: '设为 1 时一次返回全部（最多 5000 条）', example: '1' },
        ],
        responseExample: JSON.stringify({ data: [{ id: 1, name: 'MY_TOKEN', value: 'abc123', enabled: true, remarks: '签到Token' }], total: 1 }, null, 2),
        responseFields: [
          { name: 'id', type: 'integer', description: '变量 ID' },
          { name: 'name', type: 'string', description: '变量名' },
          { name: 'value', type: 'string', description: '变量值' },
          { name: 'enabled', type: 'boolean', description: '是否启用' },
          { name: 'remarks', type: 'string', description: '备注' },
        ],
      },
      {
        id: 'envs-get',
        method: 'GET',
        path: '/api/envs/:id',
        title: '按 ID 获取环境变量',
        description: '根据变量 ID 直接返回单条环境变量详情，避免按 keyword 反复查询匹配。',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '变量 ID' }],
        responseExample: JSON.stringify({ data: { id: 1, name: 'MY_TOKEN', value: 'abc123', enabled: true, remarks: '签到Token', group: '京东' } }, null, 2),
      },
      {
        id: 'envs-create',
        method: 'POST',
        path: '/api/envs',
        title: '创建环境变量',
        description: '创建新的环境变量',
        auth: 'jwt',
        bodyParams: [
          { name: 'name', type: 'string', required: true, description: '变量名', example: 'MY_TOKEN' },
          { name: 'value', type: 'string', required: true, description: '变量值', example: 'abc123' },
          { name: 'remarks', type: 'string', description: '备注' },
          { name: 'group', type: 'string', description: '分组名称' },
        ],
        responseExample: JSON.stringify({ message: '创建成功', data: { id: 1 } }, null, 2),
      },
      {
        id: 'envs-update',
        method: 'PUT',
        path: '/api/envs/:id',
        title: '更新环境变量',
        description: '更新指定环境变量',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '变量 ID' }],
        bodyParams: [
          { name: 'name', type: 'string', description: '变量名' },
          { name: 'value', type: 'string', description: '变量值' },
          { name: 'remarks', type: 'string', description: '备注' },
          { name: 'group', type: 'string', description: '分组名称' },
        ],
        responseExample: JSON.stringify({ message: '更新成功' }, null, 2),
      },
      {
        id: 'envs-delete',
        method: 'DELETE',
        path: '/api/envs/:id',
        title: '删除环境变量',
        description: '删除指定环境变量',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '变量 ID' }],
        responseExample: JSON.stringify({ message: '删除成功' }, null, 2),
      },
    ],
  },
  {
    key: 'subscriptions',
    label: '订阅管理',
    endpoints: [
      {
        id: 'subs-list',
        method: 'GET',
        path: '/api/subscriptions',
        title: '获取订阅列表',
        description: '获取所有仓库订阅',
        auth: 'jwt',
        responseExample: JSON.stringify({ data: [{ id: 1, name: '示例仓库', url: 'https://github.com/user/repo.git', branch: 'main', schedule: '0 0 * * *', enabled: true }] }, null, 2),
      },
      {
        id: 'subs-create',
        method: 'POST',
        path: '/api/subscriptions',
        title: '创建订阅',
        description: '创建新的仓库订阅',
        auth: 'jwt',
        bodyParams: [
          { name: 'name', type: 'string', required: true, description: '订阅名称' },
          { name: 'url', type: 'string', required: true, description: '仓库 URL（HTTP/HTTPS）' },
          { name: 'branch', type: 'string', description: '分支，默认 main', example: 'main' },
          { name: 'schedule', type: 'string', description: 'Cron 表达式', example: '0 0 * * *' },
          { name: 'whitelist', type: 'string', description: '白名单：文件名/路径片段，「子串包含」匹配（非 glob、非正则），多个用 , 或 | 分隔；片段命中目录名时该目录下的全部文件（含多级子目录）都算命中。命中的文件才会检出落盘并建成定时任务；留空表示全部命中', example: 'jd_|jx_|jddj_' },
          { name: 'blacklist', type: 'string', description: '黑名单：匹配规则同白名单（片段命中目录名时整个目录都被排除）。命中的文件既不检出也不建任务', example: 'backUp' },
          { name: 'depend_on', type: 'string', description: '依赖规则：对应青龙 ql repo 的第 4 个参数 dependence，匹配规则同白名单（填 utils 会把 utils/ 目录下的文件一并检出）。命中的文件会被检出落盘供主脚本调用，但不会建成定时任务；白名单为空时本字段不生效', example: 'sendNotify|utils' },
          { name: 'sub_path', type: 'string', description: '只检出仓库内的指定子目录（多个用 , 或 | 分隔），优先级高于白名单' },
          { name: 'save_dir', type: 'string', description: '脚本存放子目录，留空则按仓库名推导' },
          { name: 'pre_script', type: 'string', description: '拉取前指令：在 git 拉取之前执行的 Shell 命令，可用 $SUB_DIR / $SCRIPTS_DIR / $QL_DIR 等变量。非 0 退出会中断本次拉取并记为失败', example: 'mount -a' },
          { name: 'hook_script', type: 'string', description: '拉取后钩子：拉取成功后、同步定时任务之前执行的 Shell 命令，变量与失败语义同 pre_script', example: 'bash $SUB_DIR/copyfiles.sh' },
          { name: 'overwrite_mode', type: 'string', description: '覆盖拉取策略，仅对 git 仓库订阅生效：inherit=跟随系统设置里的「覆盖拉取（默认）」开关（默认值）、force=强制覆盖本地改动、preserve=拉取前暂存本地改动再恢复。作用域只有脚本文件（git 工作区），不影响任务的名称与定时；首次拉取（本地还没有仓库）不适用。不传或传非法值一律按 inherit 处理', example: 'preserve' },
        ],
        responseExample: JSON.stringify({ message: '创建成功', data: { id: 1 } }, null, 2),
      },
      {
        id: 'subs-update',
        method: 'PUT',
        path: '/api/subscriptions/:id',
        title: '更新订阅',
        description: '更新指定订阅配置。请求体为部分更新，字段与「创建订阅」一致（含 whitelist / blacklist / depend_on / sub_path / overwrite_mode），只提交需要修改的字段即可。其中 overwrite_mode 的取值为 inherit / force / preserve，非法值会被归一成 inherit。',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '订阅 ID' }],
        responseExample: JSON.stringify({ message: '更新成功' }, null, 2),
      },
      {
        id: 'subs-delete',
        method: 'DELETE',
        path: '/api/subscriptions/:id',
        title: '删除订阅',
        description: '删除指定订阅',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '订阅 ID' }],
        responseExample: JSON.stringify({ message: '删除成功' }, null, 2),
      },
      {
        id: 'subs-pull',
        method: 'PUT',
        path: '/api/subscriptions/:id/pull',
        title: '手动拉取订阅',
        description: '立即拉取指定订阅的脚本。拉取时是否覆盖本地修改由该订阅自己的 overwrite_mode 决定（inherit 时回落到系统设置里的「覆盖拉取（默认）」开关），本接口不接收临时覆盖模式参数。',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '订阅 ID' }],
        responseExample: JSON.stringify({ message: '拉取成功，拉取 5 个文件，新增 3 个任务' }, null, 2),
      },
    ],
  },
  {
    key: 'notifications',
    label: '通知渠道',
    endpoints: [
      {
        id: 'notify-list',
        method: 'GET',
        path: '/api/notifications',
        title: '获取通知渠道列表',
        description: '获取所有通知渠道配置',
        auth: 'jwt',
        responseExample: JSON.stringify({ data: [{ id: 1, name: '钉钉通知', type: 'dingtalk', config: { token: '***' }, push_scope: 'default', enabled: true }] }, null, 2),
      },
      {
        id: 'notify-create',
        method: 'POST',
        path: '/api/notifications',
        title: '创建通知渠道',
        description: '创建新的通知渠道，支持：webhook / email / telegram(支持 api_host、proxy 单独代理) / dingtalk / wecom(企业微信机器人，支持 text/markdown/markdown_v2/image/news/template_card) / wecom_app(企业微信应用，支持 text/markdown/image/file/video/news/template_card，并支持 base_url 反代基础地址) / bark / pushplus(支持 channel 选择发送渠道：wechat/app/extension/webhook/clawbot/cp/mail/sms/voice，webhook 与 cp 需配合 option 填渠道编码) / serverchan / feishu / gotify / pushdeer / pushme / chanify / igot / qmsg / pushover / discord / slack / ntfy / wxpusher(WxPusher / ClawBot(iLink)，支持 url、verify_pay_type) / custom',
        auth: 'jwt',
        bodyParams: [
          { name: 'name', type: 'string', required: true, description: '渠道名称' },
          { name: 'type', type: 'string', required: true, description: '渠道类型', example: 'dingtalk' },
          { name: 'config', type: 'object', required: true, description: '渠道配置（各类型字段不同，例如 email 可填 smtp_ssl，telegram 可填 proxy，wecom_app 可填 base_url，wxpusher 可填 url / verify_pay_type）' },
          { name: 'push_scope', type: 'string', description: '推送范围：default（默认推送，参与广播）/ bound（绑定推送，只有被任务绑定或调用时显式指定才推送）。留空按 default 处理', example: 'default' },
        ],
        responseExample: JSON.stringify({ message: '创建成功', data: { id: 1 } }, null, 2),
      },
      {
        id: 'notify-update',
        method: 'PUT',
        path: '/api/notifications/:id',
        title: '更新通知渠道',
        description: '更新指定通知渠道。按键更新：请求里没出现的键不会改动已有值',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '渠道 ID' }],
        bodyParams: [
          { name: 'name', type: 'string', description: '渠道名称' },
          { name: 'type', type: 'string', description: '渠道类型' },
          { name: 'config', type: 'string', description: '渠道配置 JSON 字符串' },
          { name: 'push_scope', type: 'string', description: '推送范围：default / bound。不传则保持原值', example: 'bound' },
        ],
        responseExample: JSON.stringify({ message: '更新成功' }, null, 2),
      },
      {
        id: 'notify-delete',
        method: 'DELETE',
        path: '/api/notifications/:id',
        title: '删除通知渠道',
        description: '删除指定通知渠道',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '渠道 ID' }],
        responseExample: JSON.stringify({ message: '删除成功' }, null, 2),
      },
      {
        id: 'notify-test',
        method: 'POST',
        path: '/api/notifications/:id/test',
        title: '测试发送',
        description: '向指定渠道发送测试通知',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '渠道 ID' }],
        responseExample: JSON.stringify({ message: '测试通知发送成功' }, null, 2),
      },
      {
        id: 'notify-send',
        method: 'POST',
        path: '/api/notifications/send',
        title: '脚本发送通知',
        description: '供脚本或外部程序主动调用系统通知配置进行推送。支持普通用户 JWT，也支持带 notifications scope 的 Open API Bearer Token。未指定 channel_id / channel_ids 时走广播，只会发送到「默认推送」（push_scope=default）且已启用的渠道，设为「绑定推送」的渠道不会收到；显式指定渠道 ID 时按 ID 精确投递，绑定推送渠道同样能收到。一个「默认推送」渠道都没有时不做兜底，直接返回失败。任务自带默认通知渠道时，helper 会优先落到该渠道，传 ignore_default_config=true 可跳过它 —— 注意跳过后就是走广播，也就是只发到「默认推送」渠道，而不是发给所有渠道。面板运行脚本时会统一在脚本根目录提供 notify.py 和 sendNotify.js，不再向每个脚本子目录复制，可直接按青龙风格先收集 notifyStr 再发送。',
        auth: 'jwt',
        bodyParams: [
          { name: 'title', type: 'string', required: true, description: '通知标题', example: '签到脚本通知' },
          { name: 'content', type: 'string', required: true, description: '通知正文，通常传 notifyStr.join(\'\\n\') 或 "\\n".join(notify_lines)', example: '签到成功\\n账号: user01\\n积分: +20' },
          { name: 'channel_id', type: 'integer', description: '单个通知渠道 ID，可选；传了就必须大于 0，否则返回 400（不再静默退化成广播）', example: '3' },
          { name: 'channel_ids', type: 'array', description: '多个通知渠道 ID，可选；非空数组里必须至少有一个大于 0 的 ID，否则返回 400。空数组等同不传，按广播处理', example: '[3,5]' },
          { name: 'context', type: 'object', description: '额外模板变量，可选；供 content_template 使用', example: '{"task_name":"签到脚本","status":"success"}' },
        ],
        helperExamples: {
          JavaScript: `const { sendNotify } = require('./sendNotify')

async function main() {
  const name = '京东签到'
  const notifyStr = []
  notifyStr.push('签到成功')
  notifyStr.push('账号: user01')
  notifyStr.push('积分: +20')
  await sendNotify(name, notifyStr.join('\\n'))

  // 如需忽略任务默认通知渠道：
  // await sendNotify(name, notifyStr.join('\\n'), { channel_ids: [1, 2], ignore_default_config: true })
}

main().catch(console.error)`,
          Python: `from notify import send

def main():
    name = '京东签到'
    notify_lines = []
    notify_lines.append('签到成功')
    notify_lines.append('账号: user01')
    notify_lines.append('积分: +20')
    send(name, '\\n'.join(notify_lines))

    # 如需忽略任务默认通知渠道：
    # send(name, '\\n'.join(notify_lines), ignore_default_config=True, channel_ids=[1, 2])

if __name__ == '__main__':
    main()`,
        },
        responseExample: JSON.stringify({
          message: '通知发送完成，成功 1 个渠道',
          data: {
            sent_count: 1,
            failed_count: 0,
            channel_names: ['Telegram 主通道'],
            errors: [],
            requested_ids: [3],
            used_all: false,
            content_length: 18,
          },
        }, null, 2),
      },
    ],
  },
  {
    key: 'deps',
    label: '依赖管理',
    endpoints: [
      {
        id: 'deps-list',
        method: 'GET',
        path: '/api/deps',
        title: '获取依赖列表',
        description: '按类型获取依赖列表',
        auth: 'jwt',
        queryParams: [
          { name: 'type', type: 'string', required: true, description: '依赖类型：nodejs / python / linux', example: 'python' },
        ],
        responseExample: JSON.stringify({ data: [{ id: 1, type: 'python', name: 'requests', status: 'installed' }], total: 1 }, null, 2),
      },
      {
        id: 'deps-create',
        method: 'POST',
        path: '/api/deps',
        title: '安装依赖',
        description: '按类型批量提交依赖安装任务',
        auth: 'jwt',
        bodyParams: [
          { name: 'type', type: 'string', required: true, description: '依赖类型', example: 'python' },
          { name: 'names', type: 'array', required: true, description: '依赖名称数组', example: '["requests"]' },
        ],
        responseExample: JSON.stringify({ message: '已提交 1 个依赖安装', data: [{ id: 1, type: 'python', name: 'requests', status: 'installing' }] }, null, 2),
      },
      {
        id: 'deps-delete',
        method: 'DELETE',
        path: '/api/deps/:id',
        title: '卸载依赖',
        description: '卸载指定依赖，支持 force 强制卸载',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '依赖 ID' }],
        queryParams: [{ name: 'force', type: 'boolean', description: '是否强制卸载', example: 'true' }],
        responseExample: JSON.stringify({ message: '卸载中' }, null, 2),
      },
      {
        id: 'deps-status',
        method: 'GET',
        path: '/api/deps/:id/status',
        title: '获取依赖状态',
        description: '获取单个依赖的状态和日志',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '依赖 ID' }],
        responseExample: JSON.stringify({ data: { id: 1, type: 'python', name: 'requests', status: 'installed', log: 'install ok' } }, null, 2),
      },
      {
        id: 'deps-reinstall',
        method: 'PUT',
        path: '/api/deps/:id/reinstall',
        title: '重新安装依赖',
        description: '重新安装指定依赖',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '依赖 ID' }],
        responseExample: JSON.stringify({ message: '重新安装中' }, null, 2),
      },
    ],
  },
  {
    key: 'users',
    label: '用户管理',
    endpoints: [
      {
        id: 'users-list',
        method: 'GET',
        path: '/api/users',
        title: '获取用户列表',
        description: '获取所有用户（仅管理员）',
        auth: 'jwt',
        responseExample: JSON.stringify({ data: [{ id: 1, username: 'admin', role: 'admin', enabled: true, last_login_at: '2026-03-10T00:00:00' }] }, null, 2),
      },
      {
        id: 'users-create',
        method: 'POST',
        path: '/api/users',
        title: '创建用户',
        description: '创建新用户（仅管理员）',
        auth: 'jwt',
        bodyParams: [
          { name: 'username', type: 'string', required: true, description: '用户名' },
          { name: 'password', type: 'string', required: true, description: '密码（至少8位）' },
          { name: 'role', type: 'string', required: true, description: '角色：admin / operator / viewer' },
        ],
        responseExample: JSON.stringify({ message: '创建成功', data: { id: 2 } }, null, 2),
      },
      {
        id: 'users-update',
        method: 'PUT',
        path: '/api/users/:id',
        title: '更新用户',
        description: '更新用户信息（仅管理员）',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '用户 ID' }],
        bodyParams: [
          { name: 'role', type: 'string', description: '角色' },
          { name: 'enabled', type: 'boolean', description: '是否启用' },
          { name: 'password', type: 'string', description: '新密码' },
        ],
        responseExample: JSON.stringify({ message: '更新成功' }, null, 2),
      },
      {
        id: 'users-delete',
        method: 'DELETE',
        path: '/api/users/:id',
        title: '删除用户',
        description: '删除指定用户（仅管理员，不能删除自己）',
        auth: 'jwt',
        pathParams: [{ name: 'id', type: 'integer', required: true, description: '用户 ID' }],
        responseExample: JSON.stringify({ message: '删除成功' }, null, 2),
      },
    ],
  },
  {
    key: 'open',
    label: '开放 API',
    endpoints: [
      {
        id: 'open-apps-list',
        method: 'GET',
        path: '/api/open-api/apps',
        title: '获取应用列表',
        description: '获取所有开放 API 应用',
        auth: 'jwt',
        responseExample: JSON.stringify({ data: [{ id: 1, name: '自动化工具', client_id: 'cid_xxx', client_secret: 'cs_xxx', enabled: true, scopes: 'tasks,envs,notifications' }] }, null, 2),
      },
      {
        id: 'open-token',
        method: 'POST',
        path: '/api/open-api/token',
        title: '获取开放 API Token',
        description: '使用 App Key 和 App Secret 获取访问令牌，有效期 24 小时',
        auth: 'none',
        bodyParams: [
          { name: 'app_key', type: 'string', required: true, description: 'App Key' },
          { name: 'app_secret', type: 'string', required: true, description: 'App Secret' },
        ],
        responseExample: JSON.stringify({ data: { access_token: 'eyJhbGciOi...', token_type: 'Bearer', expires_in: 86400 } }, null, 2),
      },
    ],
  },
  {
    key: 'config',
    label: '系统配置',
    endpoints: [
      {
        id: 'config-get',
        method: 'GET',
        path: '/api/configs',
        title: '获取全部系统配置',
        description: '获取所有系统配置项及其值',
        auth: 'jwt',
        responseExample: JSON.stringify({ data: { auto_add_cron: { key: 'auto_add_cron', value: 'true', description: '订阅拉取时自动创建任务' }, proxy_url: { key: 'proxy_url', value: '', description: '代理地址' } } }, null, 2),
      },
      {
        id: 'config-update',
        method: 'PUT',
        path: '/api/configs/batch',
        title: '批量更新配置',
        description: '批量更新系统配置（仅管理员）',
        auth: 'jwt',
        bodyParams: [
          { name: 'configs', type: 'object', required: true, description: '配置键值对', example: '{ "proxy_url": "http://127.0.0.1:7890" }' },
        ],
        responseExample: JSON.stringify({ message: '配置已保存' }, null, 2),
      },
    ],
  },
  {
    key: 'system',
    label: '系统信息',
    endpoints: [
      {
        id: 'system-info',
        method: 'GET',
        path: '/api/system/info',
        title: '获取系统信息',
        description: '获取服务器系统信息（CPU/内存/磁盘/机器码等）。自 v3.0.4 起同层追加 deployment_type（docker / binary / magisk）与 magisk_shell_version（Magisk 模块外壳版本，非模块版为 0），原有字段位置不变。',
        auth: 'jwt',
        responseExample: JSON.stringify({
          data: { hostname: 'server', machine_code: 'A1B2C3D4-E5F6-4789-ABCD-1234567890AB', os: 'linux', arch: 'amd64', go_version: 'go1.22.0', num_cpu: 4, cpu_usage: 25.0, memory_total: 8589934592, memory_used: 4294967296, memory_usage: 50.0, disk_total: 107374182400, disk_used: 53687091200, disk_usage: 50.0, deployment_type: 'docker', magisk_shell_version: 0 },
        }, null, 2),
      },
      {
        id: 'system-machine-code',
        method: 'GET',
        path: '/api/system/machine-code',
        title: '获取面板机器码',
        description: '直接读取面板首次启动生成的机器码（UUID v4 大写格式）。不再需要手工查 SQL，OpenAPI 应用具备 system 权限即可调用。',
        auth: 'jwt',
        responseExample: JSON.stringify({ data: { machine_code: 'A1B2C3D4-E5F6-4789-ABCD-1234567890AB' } }, null, 2),
      },
      {
        id: 'system-stats',
        method: 'GET',
        path: '/api/system/stats',
        title: '获取面板统计',
        description: '获取任务、日志、脚本的统计数据',
        auth: 'jwt',
        responseExample: JSON.stringify({
          data: { tasks: { total: 10, enabled: 8, disabled: 2, running: 1 }, logs: { total: 105, success: 90, failed: 10, aborted: 5, success_rate: 90.0 }, scripts: { total: 15 } },
        }, null, 2),
      },
    ],
  },
  {
    key: 'backup',
    label: '系统备份',
    endpoints: [
      {
        id: 'backup-create',
        method: 'POST',
        path: '/api/system/backup',
        title: '一键创建备份',
        description: '创建数据库与脚本数据备份；支持管理员账号 Token 或 OpenAPI 应用（需 backup 权限）调用。',
        auth: 'jwt',
        bodyParams: [
          { name: 'name', type: 'string', required: false, example: 'auto-backup', description: '备份文件名前缀，可省略由系统自动生成' },
          { name: 'password', type: 'string', required: false, example: '', description: '可选加密密码，留空则导出明文 .json 文件' },
          { name: 'selection', type: 'object', required: false, example: '{}', description: '可选模块选择，留空导出全部内容' },
        ],
        responseExample: JSON.stringify({ data: { path: 'data/backups/daidai-backup-20260101-120000.json' }, message: '备份成功' }, null, 2),
      },
      {
        id: 'backup-list',
        method: 'GET',
        path: '/api/system/backups',
        title: '获取备份列表',
        description: '列出当前面板已生成的全部备份文件',
        auth: 'jwt',
        responseExample: JSON.stringify({ data: [{ filename: 'daidai-backup-20260101.json', size: 102400, modified_at: '2026-01-01T12:00:00Z' }] }, null, 2),
      },
      {
        id: 'backup-delete',
        method: 'DELETE',
        path: '/api/system/backup',
        title: '删除备份文件',
        description: '按文件名删除一个备份文件（filename 通过 query 传递）',
        auth: 'jwt',
        responseExample: JSON.stringify({ message: '删除成功' }, null, 2),
      },
    ],
  },
]

export function generateCodeExamples(endpoint: ApiEndpoint): Record<string, string> {
  const { method, path, bodyParams, auth } = endpoint
  const url = `${getApiBaseOrigin()}${path}`
  const hasBody = bodyParams && bodyParams.length > 0 && method !== 'GET'

  // 票据鉴权的下载接口不能套用通用模板：它没有 Authorization 头，响应也不是 JSON，
  // 而且必须先调同路径的 -ticket 接口换票，示例要把这两步一起给出来。
  if (auth === 'ticket') {
    return generateTicketDownloadExamples(url)
  }

  const bodyObj: Record<string, any> = {}
  if (hasBody) {
    bodyParams!.forEach(p => {
      if (p.example) {
        if (p.type === 'integer') {
          bodyObj[p.name] = Number(p.example)
        } else if (p.type === 'boolean') {
          bodyObj[p.name] = p.example === 'true'
        } else if (p.type === 'array' || p.type === 'object') {
          try {
            bodyObj[p.name] = JSON.parse(p.example)
          } catch {
            bodyObj[p.name] = p.example
          }
        } else {
          bodyObj[p.name] = p.example
        }
      } else {
        bodyObj[p.name] = p.type === 'integer' ? 0 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {} : ''
      }
    })
  }
  const bodyJson = JSON.stringify(bodyObj, null, 2)

  const authHeader = auth === 'jwt' ? `-H "Authorization: Bearer <TOKEN>"` : ''

  let shell = `curl -X ${method} "${url}"`
  if (authHeader) shell += ` \\\n  ${authHeader}`
  if (hasBody) shell += ` \\\n  -H "Content-Type: application/json" \\\n  -d '${bodyJson}'`

  let js = `const res = await fetch("${url}", {\n  method: "${method}",\n  headers: {\n    "Content-Type": "application/json",`
  if (auth === 'jwt') js += `\n    "Authorization": "Bearer <TOKEN>",`
  js += `\n  },`
  if (hasBody) js += `\n  body: JSON.stringify(${bodyJson}),`
  js += `\n})\nconst data = await res.json()\nconsole.log(data)`

  let python = `import requests\n\n`
  if (auth === 'jwt') python += `headers = {"Authorization": "Bearer <TOKEN>"}\n`
  if (hasBody) {
    python += `data = ${bodyJson}\n`
    python += `res = requests.${method.toLowerCase()}("${url}"${auth === 'jwt' ? ', headers=headers' : ''}, json=data)\n`
  } else {
    python += `res = requests.${method.toLowerCase()}("${url}"${auth === 'jwt' ? ', headers=headers' : ''})\n`
  }
  python += `print(res.json())`

  return { Shell: shell, JavaScript: js, Python: python }
}

function generateTicketDownloadExamples(downloadUrl: string): Record<string, string> {
  const origin = getApiBaseOrigin()
  const ticketUrl = `${downloadUrl}-ticket`

  const shell = `# 1. 换票：这一步走正常 Bearer 鉴权
curl -X GET "${ticketUrl}" \\
  -H "Authorization: Bearer <TOKEN>"
# → {"url":"...?ticket=...","filename":"...","size":20480,"expires_in":120}

# 2. 直传下载：票据在 URL 上，这一步不要再带 Authorization
#    url 是相对路径，拼到面板地址后面即可；-OJ 按 Content-Disposition 存盘
curl -OJ "${origin}<上一步返回的 url>"`

  const js = `// 1. 换票：这一步走正常 Bearer 鉴权
const res = await fetch("${ticketUrl}", {
  headers: {
    "Authorization": "Bearer <TOKEN>",
  },
})
const ticket = await res.json()

// 2. 直传下载：交给浏览器原生下载，文件不进 JS 内存，也带不上 Authorization 头
const anchor = document.createElement("a")
anchor.href = ticket.url
anchor.download = ticket.filename
anchor.click()`

  const python = `import requests

BASE = "${origin}"

# 1. 换票：这一步走正常 Bearer 鉴权
ticket = requests.get("${ticketUrl}", headers={"Authorization": "Bearer <TOKEN>"}).json()

# 2. 直传下载：票据在 URL 上，这一步不要再带 Authorization；响应是文件流，不是 JSON
with requests.get(BASE + ticket["url"], stream=True) as res:
    res.raise_for_status()
    with open(ticket["filename"], "wb") as f:
        for chunk in res.iter_content(65536):
            f.write(chunk)`

  return { Shell: shell, JavaScript: js, Python: python }
}

export function getApiBaseOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  return 'http://localhost:5701'
}
