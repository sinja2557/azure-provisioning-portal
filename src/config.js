const clientId = import.meta.env.VITE_CLIENT_ID;
const tenantId = import.meta.env.VITE_TENANT_ID;

export const AUTH_CONFIGURED = Boolean(clientId && tenantId);

export const msalConfig = {
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',
  },
};

// Azure Resource Manager를 사용자 권한으로 호출하기 위한 권한 범위
export const ARM_SCOPES = ['https://management.azure.com/user_impersonation'];

export const ARM_BASE = 'https://management.azure.com';

export const API_VERSIONS = {
  subscriptions: '2022-12-01',
  resources: '2021-04-01',
};

export const POLL_INTERVAL_MS = 10_000;

// 아래 목록은 infra/azuredeploy.json 의 allowedValues 와 일치해야 합니다.
export const LOCATIONS = [
  { value: 'koreacentral', label: '한국 중부 (koreacentral)' },
  { value: 'japaneast', label: '일본 동부 (japaneast)' },
  { value: 'southeastasia', label: '동남아시아 (southeastasia)' },
  { value: 'eastus2', label: '미국 동부 2 (eastus2)' },
  { value: 'westeurope', label: '서유럽 (westeurope)' },
];

export const VM_SIZES = [
  { value: 'Standard_B2s_v2', label: 'Standard_B2s_v2 (2 vCPU, 8 GiB)' },
  { value: 'Standard_B2as_v2', label: 'Standard_B2as_v2 (2 vCPU, 8 GiB, AMD)' },
  { value: 'Standard_D2s_v5', label: 'Standard_D2s_v5 (2 vCPU, 8 GiB)' },
];

// family: 접속 방식 (Linux = SSH 키, Windows = 비밀번호)
// client: Windows 클라이언트 이미지 여부. Azure에서 쓰려면 별도 라이선스가 필요합니다.
export const OS_IMAGES = [
  { value: 'ubuntu-2204', label: 'Ubuntu 22.04 LTS', family: 'Linux', client: false },
  { value: 'windows-server-2022', label: 'Windows Server 2022 Datacenter', family: 'Windows', client: false },
  { value: 'windows-11-25h2-pro', label: 'Windows 11 Pro 25H2', family: 'Windows', client: true },
  { value: 'windows-11-25h2-ent', label: 'Windows 11 Enterprise 25H2', family: 'Windows', client: true },
];

export const APP_SERVICE_SKUS = [
  { value: 'B1', label: 'B1 기본' },
  { value: 'S1', label: 'S1 표준' },
  { value: 'P0v3', label: 'P0v3 프리미엄' },
];
