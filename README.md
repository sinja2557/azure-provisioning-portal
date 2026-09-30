# Azure 인프라 요청 포털 (3번 방식: 브라우저에서 ARM 직접 호출)

서버 없이 동작하는 웹페이지입니다. 사용자가 Entra ID로 로그인하면 브라우저가 사용자 본인의 권한으로 Azure Resource Manager(ARM)를 직접 호출해 아래 리소스를 만듭니다.

- 리소스 그룹
- 가상 네트워크 (서브넷 3개: VM용, 웹 앱 통합용, DB용)
- 가상 머신 (Ubuntu 22.04, Windows Server 2022, Windows 11 Pro·Enterprise 25H2 중 선택, 공인 IP 없음)
- PostgreSQL 유연한 서버 + 데이터베이스 `appdb` (VNet 안에서만 접근 가능)
- App Service 요금제 + 웹 앱 (VNet 통합, DB 접속 정보를 앱 설정으로 주입)

## 폴더 구조

```
azure-provisioning-portal/
├─ index.html                 화면 구조
├─ src/
│  ├─ config.js               앱 설정, 지역·크기 목록
│  ├─ auth.js                 MSAL 로그인과 토큰 발급
│  ├─ arm.js                  ARM REST API 호출
│  ├─ app.js                  입력 검증, 배포 실행, 진행 상황 표시
│  └─ styles.css
├─ infra/
│  └─ azuredeploy.json        만들 리소스를 정의한 ARM 템플릿
├─ public/
│  └─ staticwebapp.config.json  Static Web Apps 보안 헤더
├─ .env.example
└─ package.json
```

브라우저는 Bicep을 직접 배포할 수 없어서 템플릿을 ARM JSON으로 작성했습니다. Bicep으로 관리하고 싶다면 `az bicep decompile --file infra/azuredeploy.json` 으로 변환한 뒤, 이후에는 Bicep을 수정하고 `az bicep build` 로 JSON을 다시 만들어 쓰면 됩니다.

## 1단계: Entra ID 앱 등록

1. Azure Portal → Microsoft Entra ID → 앱 등록 → 새 등록
2. 지원되는 계정 유형: "이 조직 디렉터리의 계정만"
3. 리디렉션 URI: 플랫폼을 **단일 페이지 애플리케이션(SPA)** 으로 고르고 `http://localhost:5173` 입력
   (배포 후에는 Static Web Apps 주소도 같은 곳에 추가)
4. 등록 후 **API 사용 권한** → 권한 추가 → Azure Service Management → 위임된 권한 → `user_impersonation`
5. 개요 화면의 **애플리케이션(클라이언트) ID** 와 **디렉터리(테넌트) ID** 를 복사

조직 정책에 따라 4번 권한에 관리자 동의가 필요할 수 있습니다. 첫 로그인에서 동의 오류가 나면 관리자에게 "관리자 동의 부여"를 요청하세요.

## 2단계: 로컬 실행

```bash
cp .env.example .env.local     # 복사한 ID 두 개를 채워 넣기
npm install
npm run dev                    # http://localhost:5173
```

## 3단계: 사용자 권한

이 방식은 버튼을 누른 사용자의 권한으로 리소스를 만듭니다.

- 리소스 그룹까지 새로 만들려면: 구독에 **기여자(Contributor)** 역할
- 관리자가 리소스 그룹을 미리 만들어 둔다면: 그 리소스 그룹에만 **기여자** 역할로 충분합니다. 이때 화면에는 미리 만든 이름과 같은 지역을 입력하세요.

## 4단계: Azure Static Web Apps에 배포

1. 코드를 GitHub 저장소에 올립니다 (`.env.local` 은 올라가지 않습니다).
2. Azure Portal에서 Static Web App을 만들고 저장소를 연결합니다. 빌드 설정은 앱 위치 `/`, 출력 위치 `dist` 입니다.
3. 자동 생성된 GitHub Actions 워크플로우의 빌드 단계에 환경 변수를 추가합니다.
   Vite는 빌드할 때 값을 코드에 넣기 때문에 Static Web Apps의 "환경 변수" 설정이 아니라 워크플로우에 넣어야 합니다.

   ```yaml
   env:
     VITE_CLIENT_ID: ${{ vars.VITE_CLIENT_ID }}
     VITE_TENANT_ID: ${{ vars.VITE_TENANT_ID }}
   ```
4. 배포된 주소(`https://<이름>.azurestaticapps.net`)를 1단계 앱 등록의 SPA 리디렉션 URI에 추가합니다.

## 동작 순서

1. 로그인 → MSAL이 Azure 관리용 액세스 토큰을 받아 세션 저장소에 보관
2. 구독 목록 조회 → 선택 목록 채우기
3. "환경 만들기" → 입력 검증 → 리소스 그룹 PUT
4. 배포 PUT (템플릿 + 파라미터) → 비밀번호 입력칸 비우기
5. 10초마다 배포 상태와 작업 목록 조회 → 리소스별 상태 갱신
6. 완료 시 웹 앱 주소, VM 사설 IP, DB 호스트 표시

## 알아둘 점

**비밀번호 처리.** DB 비밀번호는 `securestring` 파라미터라 배포 기록에는 남지 않지만, 웹 앱의 앱 설정 `DB_PASSWORD` 에는 평문으로 저장됩니다. 운영 환경에서는 Key Vault에 저장하고 웹 앱에서 Key Vault 참조를 쓰거나, PostgreSQL의 Entra ID 인증과 웹 앱 Managed Identity로 비밀번호 자체를 없애는 방향을 권장합니다. 두 방법 모두 배포 중 역할 할당이 필요해서 사용자에게 추가 권한이 필요합니다.

**VM 접속.** 운영체제에 따라 접속 정보가 다릅니다.

- Ubuntu: SSH 공개 키로 로그인합니다. 비밀번호 로그인은 꺼져 있습니다.
- Windows Server, Windows 11: 관리자 비밀번호(12자 이상)로 원격 데스크톱(RDP) 접속합니다.

화면에서는 선택한 운영체제에 필요한 칸만 보이고, 선택하지 않은 쪽의 값은 배포 요청에 담기지 않습니다. 두 경우 모두 VM에는 공인 IP가 없고 보안 그룹이 인터넷 인바운드를 막습니다. Azure Bastion을 같은 VNet에 추가하거나 VPN으로 접속하세요. Windows Server VM은 같은 크기의 Linux VM보다 라이선스 비용이 더 붙습니다.

**Windows 11 라이선스.** Azure에서 Windows 11을 실행하려면 Microsoft 365 E3·E5, Windows E3·E5, Windows VDA 같은 사용자별 라이선스가 있어야 합니다. Windows 11 이미지 요금에는 OS 라이선스가 포함되어 있지 않고, 템플릿은 `licenseType: Windows_Client` 로 "라이선스를 보유하고 있다"고 선언합니다. 그래서 화면에서 라이선스 보유 확인에 체크해야 요청을 보낼 수 있습니다.

**신뢰할 수 있는 시작.** Windows 11은 TPM이 필요해서 모든 VM에 Trusted Launch(보안 부팅, vTPM)를 켰습니다. 선택지의 이미지와 VM 크기는 모두 이를 지원합니다. 목록에 새 VM 크기를 추가할 때는 Trusted Launch 지원 여부를 확인하세요.

**이미지 추가.** 다른 이미지를 쓰려면 `infra/azuredeploy.json` 의 `osImages` 변수와 `osImage` 허용값, `src/config.js` 의 `OS_IMAGES` 에 같은 키로 한 줄씩 추가하면 됩니다. 이미지 이름은 `az vm image list --publisher MicrosoftWindowsDesktop --offer windows-11 --all -o table` 로 확인할 수 있습니다.

**비용.** VM, PostgreSQL, App Service 요금제는 켜져 있는 동안 계속 과금됩니다. 다 쓴 환경은 리소스 그룹을 통째로 삭제하면 모두 정리됩니다.

**다시 실행.** 같은 리소스 그룹과 접두사로 다시 요청하면 기존 리소스를 템플릿 상태로 맞추는 증분 배포가 됩니다. 단, DB 관리자 로그인 이름은 서버 생성 후 바꿀 수 없습니다.

## 문제 해결

| 증상 | 원인과 해결 |
| --- | --- |
| 로그인 후 `AADSTS50011` | 리디렉션 URI 불일치. 앱 등록의 SPA URI에 현재 주소를 정확히 추가 |
| 로그인 후 `AADSTS65001` | API 권한 동의 필요. 관리자에게 동의 요청 |
| 403 권한 없음 | 사용자에게 구독 또는 리소스 그룹 기여자 역할 부여 |
| `SkuNotAvailable` | 해당 지역에 선택한 VM 크기가 없음. 다른 크기나 지역 선택 |
| `QuotaExceeded` | 구독의 vCPU 할당량 부족. 할당량 증가 요청 |
| `MissingSubscriptionRegistration` | 리소스 공급자 미등록. 구독 → 리소스 공급자에서 `Microsoft.DBforPostgreSQL` 등을 등록 |
| PostgreSQL 생성 실패 (지역 제한) | 일부 구독 유형은 특정 지역에서 PostgreSQL 생성이 막혀 있음. 다른 지역 선택 |
