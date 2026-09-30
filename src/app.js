import './styles.css';
import template from '../infra/azuredeploy.json';
import {
  AUTH_CONFIGURED,
  LOCATIONS,
  VM_SIZES,
  OS_IMAGES,
  APP_SERVICE_SKUS,
  POLL_INTERVAL_MS,
} from './config.js';
import { initAuth, signIn, signOut } from './auth.js';
import {
  listSubscriptions,
  createResourceGroup,
  startDeployment,
  getDeployment,
  listDeploymentOperations,
  toArmParameters,
  collectErrorMessages,
} from './arm.js';

const $ = (id) => document.getElementById(id);

const els = {
  signIn: $('sign-in'),
  signOut: $('sign-out'),
  accountName: $('account-name'),
  signedOutNote: $('signed-out-note'),
  configError: $('config-error'),
  form: $('request-form'),
  formBody: $('form-fields'),
  submit: $('submit'),
  summary: $('status-summary'),
  resourceList: $('resource-list'),
  result: $('result'),
};

// 검증 대상 입력칸. 키는 readForm() 결과의 키와 같습니다.
const fields = {
  subscription: $('subscription'),
  rgName: $('rg-name'),
  location: $('location'),
  prefix: $('prefix'),
  vmSize: $('vm-size'),
  appServiceSku: $('app-sku'),
  osImage: $('os-image'),
  adminUsername: $('admin-username'),
  sshPublicKey: $('ssh-key'),
  vmPassword: $('vm-password'),
  vmPasswordConfirm: $('vm-password-confirm'),
  winLicense: $('win-license'),
  dbAdminLogin: $('db-login'),
  dbAdminPassword: $('db-password'),
  dbAdminPasswordConfirm: $('db-password-confirm'),
};

const RG_TYPE = 'resourcegroup';

// 배포 현황 목록. type 은 ARM 작업(operation)의 resourceType 과 대소문자 무시로 비교합니다.
const RESOURCE_ROWS = [
  { group: '리소스 그룹', type: RG_TYPE, label: '리소스 그룹' },
  { group: '네트워크', type: 'Microsoft.Network/networkSecurityGroups', label: '네트워크 보안 그룹' },
  { group: '네트워크', type: 'Microsoft.Network/virtualNetworks', label: '가상 네트워크와 서브넷' },
  { group: '네트워크', type: 'Microsoft.Network/privateDnsZones', label: '프라이빗 DNS 영역' },
  { group: '네트워크', type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', label: 'DNS 영역 연결' },
  { group: '가상 머신', type: 'Microsoft.Network/networkInterfaces', label: '네트워크 인터페이스' },
  { group: '가상 머신', type: 'Microsoft.Compute/virtualMachines', label: '가상 머신' },
  { group: '데이터베이스', type: 'Microsoft.DBforPostgreSQL/flexibleServers', label: 'PostgreSQL 서버' },
  { group: '데이터베이스', type: 'Microsoft.DBforPostgreSQL/flexibleServers/databases', label: '데이터베이스 appdb' },
  { group: '웹 앱', type: 'Microsoft.Web/serverfarms', label: 'App Service 요금제' },
  { group: '웹 앱', type: 'Microsoft.Web/sites', label: '웹 앱 (네트워크·DB 연결)' },
];

const STATE_TEXT = {
  pending: '대기',
  running: '만드는 중',
  done: '완료',
  failed: '실패',
};

const state = {
  account: null,
  busy: false,
  rgNameEdited: false,
};

// ---------- 화면 구성 ----------

function fillSelect(select, options, placeholder) {
  select.replaceChildren();
  if (placeholder) {
    select.append(new Option(placeholder, ''));
  }
  for (const { value, label } of options) {
    select.append(new Option(label, value));
  }
}

function buildResourceList() {
  els.resourceList.replaceChildren();
  const groups = new Map();
  for (const row of RESOURCE_ROWS) {
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }

  for (const [groupName, rows] of groups) {
    const heading = document.createElement('p');
    heading.className = 'resource-group-label';
    heading.textContent = groupName;

    const list = document.createElement('ul');
    list.className = 'resource-rows';

    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'row';
      li.dataset.type = row.type.toLowerCase();
      li.dataset.state = 'pending';

      const name = document.createElement('span');
      name.textContent = row.label;
      const status = document.createElement('span');
      status.className = 'state';
      status.textContent = STATE_TEXT.pending;

      li.append(name, status);
      list.append(li);
    }
    els.resourceList.append(heading, list);
  }
}

function setRowState(type, rowState) {
  const row = els.resourceList.querySelector(`[data-type="${CSS.escape(type.toLowerCase())}"]`);
  if (!row) return;
  row.dataset.state = rowState;
  row.querySelector('.state').textContent = STATE_TEXT[rowState];
}

function resetStatus() {
  buildResourceList();
  els.result.hidden = true;
  els.result.className = 'result';
  els.result.replaceChildren();
}

function setSummary(text) {
  els.summary.textContent = text;
}

// ARM 작업 목록을 리소스 종류별 상태로 바꿉니다. 같은 종류에 작업이 여러 개면 실패 > 진행 중 > 완료 순으로 보여줍니다.
function applyOperations(operations) {
  const rank = { done: 1, running: 2, failed: 3 };
  const byType = new Map();

  for (const op of operations) {
    const type = op.properties?.targetResource?.resourceType?.toLowerCase();
    if (!type) continue;
    const ps = op.properties.provisioningState;
    const rowState = ps === 'Succeeded' ? 'done' : ps === 'Failed' ? 'failed' : 'running';
    const current = byType.get(type);
    if (!current || rank[rowState] > rank[current]) byType.set(type, rowState);
  }

  for (const [type, rowState] of byType) {
    setRowState(type, rowState);
  }
}

function failedOperationMessages(operations) {
  return operations
    .filter((op) => op.properties?.provisioningState === 'Failed')
    .flatMap((op) => {
      const target = op.properties.targetResource?.resourceName ?? '알 수 없는 리소스';
      return collectErrorMessages(op.properties.statusMessage?.error).map((m) => `${target}: ${m}`);
    });
}

// ---------- 로그인 상태 ----------

function renderAccount(account) {
  state.account = account;
  const signedIn = Boolean(account);
  els.signIn.hidden = signedIn;
  els.signOut.hidden = !signedIn;
  els.accountName.textContent = account?.username ?? '';
  els.signedOutNote.hidden = signedIn;
  els.formBody.disabled = !signedIn || state.busy;
}

async function loadSubscriptions() {
  fillSelect(fields.subscription, [], '구독을 불러오는 중…');
  try {
    const subscriptions = await listSubscriptions();
    if (subscriptions.length === 0) {
      fillSelect(fields.subscription, [], '사용할 수 있는 구독이 없습니다');
      showFieldError('subscription', '이 계정에는 활성화된 구독이 없습니다. 다른 계정으로 로그인하세요.');
      return;
    }
    fillSelect(
      fields.subscription,
      subscriptions.map((s) => ({ value: s.subscriptionId, label: s.displayName })),
      subscriptions.length > 1 ? '구독을 선택하세요' : undefined,
    );
  } catch (error) {
    fillSelect(fields.subscription, [], '구독을 불러오지 못했습니다');
    showFieldError('subscription', error.message);
  }
}

// ---------- 입력 검증 ----------

const RESERVED_VM_USERS = new Set([
  'administrator', 'admin', 'user', 'user1', 'user2', 'user3', 'test', 'test1', 'test2',
  'root', 'guest', 'owner', 'server', 'sql', 'support', 'sys', 'console', 'backup', 'adm',
]);

const RESERVED_DB_LOGINS = new Set([
  'azure_superuser', 'azure_pg_admin', 'admin', 'administrator', 'root', 'guest', 'public',
]);

function readForm() {
  return {
    subscription: fields.subscription.value,
    rgName: fields.rgName.value.trim(),
    location: fields.location.value,
    prefix: fields.prefix.value.trim(),
    vmSize: fields.vmSize.value,
    appServiceSku: fields.appServiceSku.value,
    osImage: fields.osImage.value,
    adminUsername: fields.adminUsername.value.trim(),
    sshPublicKey: fields.sshPublicKey.value.trim().replace(/\s+/g, ' '),
    vmPassword: fields.vmPassword.value,
    vmPasswordConfirm: fields.vmPasswordConfirm.value,
    winLicense: fields.winLicense.checked,
    dbAdminLogin: fields.dbAdminLogin.value.trim(),
    dbAdminPassword: fields.dbAdminPassword.value,
    dbAdminPasswordConfirm: fields.dbAdminPasswordConfirm.value,
  };
}

function passwordCategories(pw) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
}

function validate(v) {
  const errors = {};

  if (!v.subscription) errors.subscription = '구독을 선택하세요.';

  if (!/^[\w.()-]{1,90}$/.test(v.rgName) || v.rgName.endsWith('.')) {
    errors.rgName = '영문, 숫자, 밑줄, 하이픈, 마침표, 괄호로 90자 이내로 입력하세요. 마침표로 끝날 수 없습니다.';
  }

  if (!v.location) errors.location = '지역을 선택하세요.';

  if (!/^[a-z][a-z0-9]{2,11}$/.test(v.prefix)) {
    errors.prefix = '소문자로 시작하는 소문자·숫자 3~12자로 입력하세요.';
  }

  const image = findImage(v.osImage);
  const isWindows = image?.family === 'Windows';

  if (!image) errors.osImage = '운영체제를 선택하세요.';

  if (image?.client && !v.winLicense) {
    errors.winLicense = 'Windows 11 가상 머신은 적합한 라이선스가 있어야 만들 수 있습니다.';
  }

  if (isWindows) {
    if (!/^[A-Za-z0-9._-]{1,20}$/.test(v.adminUsername) || v.adminUsername.endsWith('.')) {
      errors.adminUsername = '20자 이내의 영문·숫자·밑줄·하이픈·마침표로 입력하세요. 마침표로 끝날 수 없습니다.';
    }
  } else if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(v.adminUsername)) {
    errors.adminUsername = '소문자 또는 밑줄로 시작하는 32자 이내의 소문자·숫자·밑줄·하이픈으로 입력하세요.';
  }
  if (!errors.adminUsername && RESERVED_VM_USERS.has(v.adminUsername.toLowerCase())) {
    errors.adminUsername = `'${v.adminUsername}'은(는) Azure에서 쓸 수 없는 이름입니다.`;
  }

  if (isWindows) {
    const vmPw = v.vmPassword;
    if (vmPw.length < 12 || vmPw.length > 123) {
      errors.vmPassword = '12자 이상 123자 이하로 입력하세요.';
    } else if (passwordCategories(vmPw) < 3) {
      errors.vmPassword = '대문자, 소문자, 숫자, 기호 중 3종류 이상을 섞어 주세요.';
    } else if (v.adminUsername && vmPw.toLowerCase().includes(v.adminUsername.toLowerCase())) {
      errors.vmPassword = '비밀번호에 관리자 사용자 이름을 넣을 수 없습니다.';
    }
    if (v.vmPasswordConfirm !== vmPw) {
      errors.vmPasswordConfirm = '비밀번호가 일치하지 않습니다.';
    }
  } else if (!/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]{40,}( .*)?$/.test(v.sshPublicKey)) {
    errors.sshPublicKey = 'ssh-ed25519 또는 ssh-rsa 로 시작하는 공개 키 한 줄을 붙여 넣으세요. 개인 키는 넣지 마세요.';
  }

  const login = v.dbAdminLogin.toLowerCase();
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(v.dbAdminLogin)) {
    errors.dbAdminLogin = '영문자로 시작하는 63자 이내의 영문·숫자·밑줄로 입력하세요.';
  } else if (RESERVED_DB_LOGINS.has(login) || login.startsWith('pg_')) {
    errors.dbAdminLogin = `'${v.dbAdminLogin}'은(는) PostgreSQL에서 예약된 이름입니다.`;
  }

  const pw = v.dbAdminPassword;
  if (pw.length < 8 || pw.length > 128) {
    errors.dbAdminPassword = '8자 이상 128자 이하로 입력하세요.';
  } else if (passwordCategories(pw) < 3) {
    errors.dbAdminPassword = '대문자, 소문자, 숫자, 기호 중 3종류 이상을 섞어 주세요.';
  } else if (login && pw.toLowerCase().includes(login)) {
    errors.dbAdminPassword = '비밀번호에 관리자 로그인 이름을 넣을 수 없습니다.';
  }

  if (v.dbAdminPasswordConfirm !== pw) {
    errors.dbAdminPasswordConfirm = '비밀번호가 일치하지 않습니다.';
  }

  return errors;
}

function showFieldError(key, message) {
  const el = fields[key];
  el.setAttribute('aria-invalid', message ? 'true' : 'false');
  $(`${el.id}-error`).textContent = message ?? '';
}

function showErrors(errors) {
  for (const key of Object.keys(fields)) {
    showFieldError(key, errors[key]);
  }
}

// ---------- 결과 표시 ----------

function portalLink(subscriptionId, resourceGroup) {
  return `https://portal.azure.com/#resource/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/overview`;
}

function makeLink(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function showSuccess(outputs, request) {
  const get = (key) => outputs?.[key]?.value ?? '확인 불가';

  const heading = document.createElement('h3');
  heading.textContent = '환경이 준비되었습니다';

  const dl = document.createElement('dl');
  const entries = [
    ['웹 앱', makeLink(get('webAppUrl'), get('webAppUrl'))],
    ['VM 사설 IP', get('vmPrivateIp')],
    ['DB 호스트', get('dbHost')],
    ['리소스 그룹', makeLink(portalLink(request.subscription, request.rgName), `${request.rgName} (Azure Portal)`)],
  ];
  for (const [term, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.append(value);
    dl.append(dt, dd);
  }

  els.result.className = 'result';
  els.result.replaceChildren(heading, dl);
  els.result.hidden = false;
}

function showFailure(error, request) {
  const heading = document.createElement('h3');
  heading.textContent = error.message || '요청을 처리하지 못했습니다.';

  const nodes = [heading];
  const details = error.details ?? [];
  if (details.length) {
    const ul = document.createElement('ul');
    for (const message of details) {
      const li = document.createElement('li');
      li.textContent = message;
      ul.append(li);
    }
    nodes.push(ul);
  }

  if (request?.rgName && error.deploymentStarted) {
    const p = document.createElement('p');
    p.className = 'help';
    p.append('자세한 기록은 ', makeLink(portalLink(request.subscription, request.rgName), '리소스 그룹의 배포 기록'), '에서 볼 수 있습니다.');
    nodes.push(p);
  }

  els.result.className = 'result failed';
  els.result.replaceChildren(...nodes);
  els.result.hidden = false;
}

// ---------- 배포 ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

function deploymentName(prefix) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `portal-${prefix}-${stamp}`;
}

async function watchDeployment(subscriptionId, resourceGroup, name, startedAt) {
  let consecutiveFailures = 0;

  for (;;) {
    await sleep(POLL_INTERVAL_MS);

    let deployment;
    let operations;
    try {
      [deployment, operations] = await Promise.all([
        getDeployment(subscriptionId, resourceGroup, name),
        listDeploymentOperations(subscriptionId, resourceGroup, name),
      ]);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) throw error;
      setSummary(`상태를 가져오지 못해 다시 시도합니다. (${consecutiveFailures}/5)`);
      continue;
    }

    applyOperations(operations);

    const provisioningState = deployment.properties?.provisioningState;
    if (provisioningState === 'Succeeded') {
      return deployment.properties.outputs ?? {};
    }

    if (provisioningState === 'Failed' || provisioningState === 'Canceled') {
      const error = new Error(provisioningState === 'Canceled' ? '배포가 취소되었습니다.' : '배포에 실패했습니다.');
      const fromOperations = failedOperationMessages(operations);
      error.details = fromOperations.length ? fromOperations : collectErrorMessages(deployment.properties?.error);
      throw error;
    }

    setSummary(`배포가 진행 중입니다. ${formatElapsed(Date.now() - startedAt)} 지났습니다.`);
  }
}

function clearPasswords() {
  fields.vmPassword.value = '';
  fields.vmPasswordConfirm.value = '';
  fields.dbAdminPassword.value = '';
  fields.dbAdminPasswordConfirm.value = '';
}

function setBusy(busy) {
  state.busy = busy;
  els.formBody.disabled = busy || !state.account;
  els.submit.textContent = busy ? '만드는 중…' : '환경 만들기';
}

async function handleSubmit(event) {
  event.preventDefault();
  if (state.busy) return;

  const request = readForm();
  const errors = validate(request);
  showErrors(errors);

  const firstInvalid = Object.keys(fields).find((key) => errors[key]);
  if (firstInvalid) {
    fields[firstInvalid].focus();
    return;
  }

  setBusy(true);
  resetStatus();
  const startedAt = Date.now();
  let step = 'resourceGroup';

  try {
    setSummary('리소스 그룹을 준비하는 중입니다.');
    setRowState(RG_TYPE, 'running');
    await createResourceGroup(request.subscription, request.rgName, request.location, {
      'created-by': 'provisioning-portal',
      'requested-by': state.account.username,
    });
    setRowState(RG_TYPE, 'done');

    step = 'deployment';
    const name = deploymentName(request.prefix);
    const family = findImage(request.osImage).family;
    const parameters = toArmParameters({
      prefix: request.prefix,
      location: request.location,
      vmSize: request.vmSize,
      appServiceSku: request.appServiceSku,
      osImage: request.osImage,
      adminUsername: request.adminUsername,
      // 선택하지 않은 접속 방식의 값은 보내지 않습니다.
      sshPublicKey: family === 'Linux' ? request.sshPublicKey : '',
      adminPassword: family === 'Windows' ? request.vmPassword : '',
      dbAdminLogin: request.dbAdminLogin,
      dbAdminPassword: request.dbAdminPassword,
    });

    await startDeployment(request.subscription, request.rgName, name, template, parameters);
    clearPasswords();
    setSummary('배포를 시작했습니다. 리소스별 진행 상황이 아래에 표시됩니다.');

    const outputs = await watchDeployment(request.subscription, request.rgName, name, startedAt);
    setSummary(`배포가 끝났습니다. 총 ${formatElapsed(Date.now() - startedAt)} 걸렸습니다.`);
    showSuccess(outputs, request);
  } catch (error) {
    if (step === 'resourceGroup') setRowState(RG_TYPE, 'failed');
    error.deploymentStarted = step === 'deployment';
    setSummary('요청이 중단되었습니다. 아래 내용을 확인하세요.');
    showFailure(error, request);
  } finally {
    setBusy(false);
  }
}

// ---------- 운영체제 선택 ----------

function findImage(value) {
  return OS_IMAGES.find((image) => image.value === value);
}

// 선택한 이미지에 필요한 접속 정보 칸만 보여줍니다.
// data-os="Linux" / "Windows" 는 접속 방식, "WindowsClient" 는 Windows 11 라이선스 확인입니다.
function applyOsImage() {
  const image = findImage(fields.osImage.value);
  for (const el of document.querySelectorAll('[data-os]')) {
    const target = el.dataset.os;
    el.hidden = target === 'WindowsClient' ? !image?.client : target !== image?.family;
  }
  if (!image?.client) fields.winLicense.checked = false;
  for (const key of ['sshPublicKey', 'vmPassword', 'vmPasswordConfirm', 'winLicense', 'adminUsername']) {
    showFieldError(key, '');
  }
}

// ---------- 시작 ----------

function wireEvents() {
  els.signIn.addEventListener('click', () => signIn());
  els.signOut.addEventListener('click', () => signOut());
  els.form.addEventListener('submit', handleSubmit);
  fields.osImage.addEventListener('change', applyOsImage);

  // 리소스 그룹 이름을 직접 바꾸기 전까지는 접두사를 따라 rg-<접두사> 로 채웁니다.
  fields.rgName.addEventListener('input', () => {
    state.rgNameEdited = fields.rgName.value.trim() !== '';
  });
  fields.prefix.addEventListener('input', () => {
    if (!state.rgNameEdited) {
      const prefix = fields.prefix.value.trim();
      fields.rgName.value = prefix ? `rg-${prefix}` : '';
    }
  });

  // 입력을 고치면 해당 칸의 오류 표시를 지웁니다.
  for (const [key, el] of Object.entries(fields)) {
    const eventName = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(eventName, () => showFieldError(key, ''));
  }
}

async function init() {
  fillSelect(fields.location, LOCATIONS);
  fillSelect(fields.vmSize, VM_SIZES);
  fillSelect(fields.osImage, OS_IMAGES);
  applyOsImage();
  fillSelect(fields.appServiceSku, APP_SERVICE_SKUS);
  buildResourceList();
  wireEvents();

  if (!AUTH_CONFIGURED) {
    els.configError.textContent =
      'VITE_CLIENT_ID와 VITE_TENANT_ID가 설정되지 않았습니다. .env.example을 복사해 .env.local을 만들고 값을 채운 뒤 다시 실행하세요.';
    els.configError.hidden = false;
    els.signIn.disabled = true;
    return;
  }

  try {
    const account = await initAuth();
    renderAccount(account);
    if (account) await loadSubscriptions();
  } catch (error) {
    els.configError.textContent = `로그인을 준비하지 못했습니다: ${error.message}`;
    els.configError.hidden = false;
  }
}

init();
