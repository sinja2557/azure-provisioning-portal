import { ARM_BASE, API_VERSIONS } from './config.js';
import { getArmToken } from './auth.js';

export class ArmError extends Error {
  constructor(message, { status, code, details = [] } = {}) {
    super(message);
    this.name = 'ArmError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ARM 오류 객체는 details 안에 원인이 여러 겹으로 들어 있어서 모두 펼쳐 모읍니다.
export function collectErrorMessages(error) {
  const messages = new Set();
  (function walk(e) {
    if (!e) return;
    if (e.message) messages.add(e.code ? `${e.code}: ${e.message}` : e.message);
    (e.details ?? []).forEach(walk);
  })(error);
  return [...messages];
}

function describeStatus(status, error) {
  if (status === 401) return '로그인이 만료되었습니다. 다시 로그인하세요.';
  if (status === 403) {
    return '이 작업을 할 권한이 없습니다. 대상 구독이나 리소스 그룹에 기여자 이상의 역할이 필요합니다.';
  }
  if (status === 409) return '같은 리소스에 대한 다른 작업이 진행 중입니다. 잠시 후 다시 요청하세요.';
  return error?.message ?? `Azure 요청이 실패했습니다. (HTTP ${status})`;
}

async function armRequest(pathOrUrl, { method = 'GET', body } = {}) {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${ARM_BASE}${pathOrUrl}`;
  const token = await getArmToken();

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ArmError('Azure에 연결하지 못했습니다. 네트워크 상태를 확인하세요.');
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const error = data?.error;
    throw new ArmError(describeStatus(response.status, error), {
      status: response.status,
      code: error?.code,
      details: collectErrorMessages(error),
    });
  }

  return data;
}

// 목록 API는 nextLink로 페이지가 나뉘어 올 수 있습니다.
async function listAll(path) {
  const items = [];
  let next = path;
  while (next) {
    const page = await armRequest(next);
    items.push(...(page?.value ?? []));
    next = page?.nextLink;
  }
  return items;
}

const enc = encodeURIComponent;

const deploymentPath = (subscriptionId, resourceGroup, name) =>
  `/subscriptions/${enc(subscriptionId)}/resourcegroups/${enc(resourceGroup)}` +
  `/providers/Microsoft.Resources/deployments/${enc(name)}`;

export async function listSubscriptions() {
  const subscriptions = await listAll(`/subscriptions?api-version=${API_VERSIONS.subscriptions}`);
  return subscriptions
    .filter((s) => s.state === 'Enabled')
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// 같은 이름·위치의 리소스 그룹이 이미 있으면 그대로 두고 태그만 갱신합니다.
export function createResourceGroup(subscriptionId, name, location, tags = {}) {
  return armRequest(
    `/subscriptions/${enc(subscriptionId)}/resourcegroups/${enc(name)}?api-version=${API_VERSIONS.resources}`,
    { method: 'PUT', body: { location, tags } },
  );
}

export function startDeployment(subscriptionId, resourceGroup, name, template, parameters) {
  return armRequest(
    `${deploymentPath(subscriptionId, resourceGroup, name)}?api-version=${API_VERSIONS.resources}`,
    {
      method: 'PUT',
      body: { properties: { mode: 'Incremental', template, parameters } },
    },
  );
}

export function getDeployment(subscriptionId, resourceGroup, name) {
  return armRequest(
    `${deploymentPath(subscriptionId, resourceGroup, name)}?api-version=${API_VERSIONS.resources}`,
  );
}

export function listDeploymentOperations(subscriptionId, resourceGroup, name) {
  return listAll(
    `${deploymentPath(subscriptionId, resourceGroup, name)}/operations?api-version=${API_VERSIONS.resources}`,
  );
}

// { prefix: 'demo' } → { prefix: { value: 'demo' } }
export function toArmParameters(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
}
