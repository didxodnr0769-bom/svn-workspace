# 개발 가이드

개발 실행, 예제 데이터, 테스트와 macOS 앱 패키징 방법을 정리합니다.

[프로젝트 소개](../README.md) · [사용 가이드](USAGE.md) · [버전별 변경 내역](../CHANGELOG.md)

## 요구 사항

- macOS
- Node.js **22.12 이상**과 npm
- 별도로 설치한 Subversion CLI
- SVN 통합 테스트와 예제 생성에는 `svnadmin`, 인증 테스트에는 `svnserve` 추가 필요

SVN 실행 파일은 앱 패키지에 포함하지 않습니다. 앱의 실행 파일 연결 방법은 [사용 가이드](USAGE.md#1-svn-실행-파일-연결)를 참고하세요.

## 개발 실행

프로젝트 루트에서 실행합니다.

```sh
npm ci
npm run dev
```

개발 모드는 `http://127.0.0.1:5187`의 Vite 서버와 Electron을 함께 시작합니다. 포트가 사용 중이면 해당 서버를 종료하거나 충돌 원인을 해결한 뒤 실행하세요.

React 화면 변경은 개발 서버에 반영됩니다. Electron 메인 프로세스와 preload를 변경한 경우 개발 앱을 다시 시작해야 합니다.

빌드한 파일로 실행하려면 다음 명령을 사용합니다.

```sh
npm run build
npm start
```

빌드 결과는 `dist/`와 `dist-electron/`에 생성됩니다.

## 앱 데이터 분리

기본 설정과 암호화된 인증 정보는 Electron 사용자 데이터 디렉터리에 저장됩니다. 개발용 데이터를 분리하려면 앱을 실행하기 전에 `SVN_WORKSPACE_DATA_DIR`을 지정합니다.

```sh
SVN_WORKSPACE_DATA_DIR="$PWD/work/dev-profile" npm run dev
```

- `settings.json`: 프로젝트 경로·SVN 주소·별칭·선택 프로젝트·SVN 실행 파일 경로
- `credentials.json`: 계정명과 암호화된 비밀번호
- 커밋 목록 너비는 해당 프로필의 화면 저장소에 보관

실제 계정 정보나 프로젝트 설정 파일은 공유하지 마세요. 앱 데이터 분리는 작업 폴더나 저장소를 복제하지 않으므로, 테스트할 때는 별도의 예제 저장소를 연결하세요.

## 예제 저장소

업무 저장소에 연결하지 않고 로컬 예제 SVN 저장소와 작업 폴더를 만들 수 있습니다.

```sh
node scripts/create-demo.mjs work/demo
```

출력되는 `workspace`를 앱의 **기존 폴더 열기**에서 선택합니다. 예제에는 커밋 3개, 수정 파일 2개, 한글·공백·`@`가 포함된 새 파일 1개가 있습니다.

| 생성 경로 | 역할 |
| --- | --- |
| `work/demo/repository` | 로컬 SVN 저장소 |
| `work/demo/workspace` | 앱에서 열 작업 폴더 |
| `work/demo/peer` | 다른 작업자의 변경을 만들어 볼 두 번째 작업 폴더 |

대상 디렉터리가 이미 있으면 생성하지 않습니다. 다시 만들 때는 새로운 경로를 지정하세요. 스크립트의 기본 명령 경로는 `/opt/homebrew/bin/svn`, `/opt/homebrew/bin/svnadmin`이며 필요하면 `SVN_BINARY`, `SVNADMIN_BINARY` 환경 변수로 바꿀 수 있습니다.

## 검사와 테스트

| 명령 | 검사 범위 |
| --- | --- |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm test` | SVN 서비스 통합 테스트, 설정·인증 정보 저장, 프로젝트 관리, VS Code 실행 도우미 |
| `npm run test:renderer` | 프로젝트 전환과 늦은 응답 처리, 목록 너비 조절·복원, 별칭과 VS Code 호출 연결 |
| `npm run test:folders` | 폴더 삭제 미리보기·범위 확인·커밋, 오류 처리, 작은 창 레이아웃 |
| `npm run test:projects` | 체크아웃 폴더 선택, 실제 IPC·설정 저장, 프로젝트 제거와 재시작 복원 |

SVN 서비스 테스트는 임시 저장소와 작업 폴더를 사용합니다. 인증 테스트는 임의의 localhost 포트에서 `svnserve`를 실행하므로 로컬 통신 권한이 필요합니다. 테스트용 실행 경로가 다르면 `SVN_BINARY`, `SVNADMIN_BINARY`를 지정하세요. `svnserve`는 지정한 `svnadmin`과 같은 디렉터리에서 찾습니다.

화면 테스트는 빌드 후 별도 Electron 창을 실행합니다. 가짜 API 또는 가짜 SVN 실행 파일과 분리된 앱 데이터를 사용하므로 실제 업무 저장소를 연결하지 않습니다. 설정 저장 테스트의 암호화는 mock이며 실제 macOS 암호화 저장소의 동작까지 검증하지는 않습니다.

## macOS 앱 패키징

```sh
npm run pack:mac
npm run dist:mac
```

- `pack:mac`: `release/mac-arm64/SVN Workspace.app` 생성
- `dist:mac`: `release/`에 현재 패키지 버전의 Apple Silicon용 DMG 생성

DMG를 열고 앱을 Applications로 복사해 사용할 수 있습니다. SVN CLI는 사용하는 Mac에 별도로 설치해야 합니다.

현재 패키징 설정에는 Apple Developer 서명과 공증이 구성되어 있지 않습니다. macOS에서 실행 확인 안내가 나오면 앱 출처와 표시되는 안내를 확인하세요.

## 코드 구성

| 경로 | 역할 |
| --- | --- |
| `src/renderer/` | 프로젝트 선택, 이력, diff, 커밋·로그인 화면 |
| `src/main/main.ts` | Electron 창, IPC 검증, 작업 연결 |
| `src/main/svn-service.ts` | SVN 실행, XML 해석, 경로·변경 범위 검증 |
| `src/main/storage.ts` | 프로젝트 설정과 암호화된 인증 정보 저장 |
| `src/main/editor.ts` | VS Code 실행 파일 탐색과 프로젝트 폴더 열기 |
| `src/main/preload.ts` | 화면에 공개하는 제한된 API |
| `src/shared/` | 공통 타입과 변경 항목 판별 |
| `scripts/` | 개발 실행, 빌드, 예제 생성 |
| `tests/` | SVN·설정·편집기 테스트와 Electron 화면 검증 |
