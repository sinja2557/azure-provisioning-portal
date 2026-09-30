import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-browser';
import { msalConfig, ARM_SCOPES } from './config.js';

let pca;

// 페이지가 열릴 때 한 번 호출합니다. 로그인 리디렉션에서 돌아온 경우 결과를 처리합니다.
export async function initAuth() {
  pca = new PublicClientApplication(msalConfig);
  await pca.initialize();

  const result = await pca.handleRedirectPromise();
  if (result?.account) {
    pca.setActiveAccount(result.account);
  }

  if (!pca.getActiveAccount()) {
    const [first] = pca.getAllAccounts();
    if (first) pca.setActiveAccount(first);
  }

  return pca.getActiveAccount();
}

export function signIn() {
  return pca.loginRedirect({ scopes: ARM_SCOPES, prompt: 'select_account' });
}

export function signOut() {
  return pca.logoutRedirect({ account: pca.getActiveAccount() });
}

// ARM 호출용 액세스 토큰. 캐시된 토큰이나 갱신 토큰을 먼저 쓰고,
// 사용자 확인이 필요한 경우에만 로그인 화면으로 보냅니다.
export async function getArmToken() {
  const account = pca?.getActiveAccount();
  if (!account) {
    throw new Error('로그인이 필요합니다.');
  }

  try {
    const { accessToken } = await pca.acquireTokenSilent({ scopes: ARM_SCOPES, account });
    return accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      await pca.acquireTokenRedirect({ scopes: ARM_SCOPES, account });
      // 리디렉션이 시작되면 페이지를 떠나므로 이후 코드는 실행되지 않습니다.
      return new Promise(() => {});
    }
    throw error;
  }
}
