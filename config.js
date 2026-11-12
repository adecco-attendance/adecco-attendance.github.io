// =====================================================================
//  설정 파일 - Supabase 프로젝트 정보로 바꿔주세요.
//  Supabase 대시보드 > Project Settings > API 에서 확인할 수 있습니다.
//  (anon key는 공개되어도 괜찮은 키입니다. service_role 키는 절대 넣지 마세요!)
// =====================================================================
window.CONFIG = {
  SUPABASE_URL: 'https://tjdeajvepgpsceqzentc.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRqZGVhanZlcGdwc2NlcXplbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0NjE1NjksImV4cCI6MjExMDAzNzU2OX0.9nBBvJA-se9T2Ar6Ii92RnNQ-F_aA-iIfdeDFqcR8yg',

  // 직원 계정 이메일의 도메인. 로그인 시 아이디만 입력하면 뒤에 자동으로 붙습니다.
  // 예) 'mycompany.com' → 'hong' 입력 시 'hong@mycompany.com' 으로 로그인
  // 실제로 메일을 받을 수 있는 주소가 아니어도 됩니다.
  EMAIL_DOMAIN: 'adecco-attendance.com',

  COMPANY_NAME: '아데코코리아',
};
