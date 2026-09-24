import { readFileSync } from 'node:fs';

// MCPのローカル設定。設定ファイルは接続先とtokenを保持する環境変数の「名前」だけを持ち、
// token本文は環境変数からのみ読む。接続先はHTTPSまたは開発用loopback HTTPだけを許可する。
export interface McpConfig {
  apiUrl: string;
  token: string;
}

interface McpConfigFile {
  api_url_env?: unknown;
  api_token_env?: unknown;
}

// collectorのapi_url契約と同じloopback hostだけを許可する。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function loadMcpConfig(env: NodeJS.ProcessEnv): McpConfig {
  const configPath = env.YORI_MCP_CONFIG;
  if (!configPath) {
    throw new Error('YORI_MCP_CONFIGが未設定です');
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as McpConfigFile;
  const apiUrlEnv = raw.api_url_env;
  const apiTokenEnv = raw.api_token_env;
  if (typeof apiUrlEnv !== 'string' || typeof apiTokenEnv !== 'string' || apiUrlEnv.length === 0 || apiTokenEnv.length === 0) {
    throw new Error('MCP設定ファイルの環境変数名が不正です');
  }
  const apiUrl = env[apiUrlEnv];
  const token = env[apiTokenEnv];
  if (apiUrl === undefined || apiUrl.length === 0 || token === undefined || token.length === 0) {
    throw new Error('MCP設定が指す環境変数が未設定です');
  }
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error('MCPの接続先URLが不正です');
  }
  // 資格情報・query・fragmentは接続先の同一性を曖昧にするため、collector契約と同じく拒否する。
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error('MCPの接続先に資格情報・query・fragmentは指定できません');
  }
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error('MCPの接続先はHTTPSまたはloopback HTTPだけを許可します');
    }
  } else if (url.protocol !== 'https:') {
    throw new Error('MCPの接続先はHTTPSまたはloopback HTTPだけを許可します');
  }
  return { apiUrl: url.toString(), token };
}
