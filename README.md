# 내 아파트 찾기 (1단계)

서울 구를 고르고 예산·크기를 정하면 최근 실거래된 아파트를 단지별로 보여주는 웹사이트예요.

## 파일 구성
- `index.html` — 화면
- `api/trades.js` — 국토교통부 실거래가를 불러오는 서버 함수
- `dev-server.js` — 내 컴퓨터에서 미리 볼 때만 쓰는 서버 (Node.js 필요, 없어도 배포는 가능)

## 인터넷에 올리기 (코딩 없이, 브라우저만으로)
1. github.com 가입 → 오른쪽 위 **+** → **New repository** → 이름 `apt-finder` → **Create repository**
2. 화면의 **uploading an existing file** 클릭 → 압축 푼 폴더 안의 파일·폴더를 전부 끌어다 놓기 → **Commit changes**
3. vercel.com 에서 **Continue with GitHub**로 가입 → **Add New → Project** → `apt-finder` **Import**
4. **Environment Variables**에 이름 `MOLIT_API_KEY`, 값에 공공데이터포털 인증키(Decoding) 붙여넣기 → **Deploy**
5. 1분 뒤 나오는 주소(예: `apt-finder-xxxx.vercel.app`)가 내 사이트예요.

키를 아직 못 받았으면 4번을 건너뛰고 배포해도 돼요. 예시 데이터로 화면이 나오고, 나중에 Vercel 프로젝트 **Settings → Environment Variables**에서 키를 넣고 **Redeploy** 하면 실제 데이터가 나와요.

## 알아두기
- 평수는 **전용면적** 기준이에요 (전용 59㎡ ≈ 18평 = 흔히 말하는 24평형).
- 취소된 거래는 빠져 있어요. 이번 달 거래는 신고 기한(30일) 때문에 아직 다 안 올라왔을 수 있어요.
