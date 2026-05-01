(function () {
  const TOKEN_KEY = 'daacs_access_token';

  function normalizeAuthEmail(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value.includes('@')) {
      return value ? value + '@daacsuser.com' : '';
    }
    return value;
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function showAuth() {
    document.getElementById('auth-section').classList.remove('hidden');
    document.getElementById('me-section').classList.add('hidden');
  }

  function showMe(email) {
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('me-section').classList.remove('hidden');
    document.getElementById('me-email').textContent = email || '';
    refreshCliHint();
  }

  function refreshCliHint() {
    invoke('omni_cli_which').then(function (info) {
      var preferred = info.preferred || 'gemini';
      var codex = info.codex ? 'O' : 'X';
      var gemini = info.gemini ? 'O' : 'X';
      document.getElementById('cli-hint').textContent = 'CLI: codex ' + codex + ' / gemini ' + gemini + ' (prefer: ' + preferred + ')';
    }).catch(function () {
      document.getElementById('cli-hint').textContent = 'CLI 상태를 불러올 수 없습니다.';
    });
  }

  function showError(msg) {
    const el = document.getElementById('auth-error');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function invoke(cmd, args) {
    if (typeof window.__TAURI__ === 'undefined' || !window.__TAURI__.core) {
      return Promise.reject(new Error('Tauri not available'));
    }
    return window.__TAURI__.core.invoke(cmd, args || {});
  }

  document.getElementById('tab-login').addEventListener('click', function () {
    document.getElementById('tab-login').classList.add('active');
    document.getElementById('tab-register').classList.remove('active');
    document.getElementById('login-form').classList.remove('hidden');
    document.getElementById('register-form').classList.add('hidden');
    showError('');
  });

  document.getElementById('tab-register').addEventListener('click', function () {
    document.getElementById('tab-register').classList.add('active');
    document.getElementById('tab-login').classList.remove('active');
    document.getElementById('register-form').classList.remove('hidden');
    document.getElementById('login-form').classList.add('hidden');
    showError('');
  });

  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    const email = normalizeAuthEmail(document.getElementById('login-email').value);
    const password = document.getElementById('login-password').value;
    invoke('auth_login', { email, password })
      .then(function (data) {
        if (data && data.access_token) setToken(data.access_token);
        showMe(data && data.user ? data.user.email : email);
      })
      .catch(function (err) {
        showError(err && (err.message || String(err)) || '로그인 실패');
      });
  });

  document.getElementById('register-form').addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    const email = normalizeAuthEmail(document.getElementById('register-email').value);
    const password = document.getElementById('register-password').value;
    const projectName = document.getElementById('register-project').value.trim() || 'Default Project';
    invoke('auth_register', { email, password, project_name: projectName || null })
      .then(function (data) {
        if (data && data.access_token) setToken(data.access_token);
        showMe(data && data.user ? data.user.email : email);
      })
      .catch(function (err) {
        showError(err && (err.message || String(err)) || '회원가입 실패');
      });
  });

  document.getElementById('logout-btn').addEventListener('click', function () {
    const token = getToken();
    if (token) invoke('auth_logout', { access_token: token }).then(function () { setToken(null); showAuth(); }).catch(function () { setToken(null); showAuth(); });
    else showAuth();
  });

  document.getElementById('command-run').addEventListener('click', function () {
    var input = document.getElementById('command-input');
    var output = document.getElementById('command-output');
    var btn = document.getElementById('command-run');
    if (!input || !output || !btn) return;
    var text = (input.value || '').trim();
    if (!text) return;
    btn.disabled = true;
    output.textContent = '실행 중...';
    try {
      invoke('omni_cli_run_command', { instruction: text, cwd: null })
        .then(function (r) {
          if (!output) return;
          var lines = [];
          if (r && typeof r.stdout === 'string') lines.push('[stdout]\n' + r.stdout);
          if (r && typeof r.stderr === 'string') lines.push('[stderr]\n' + r.stderr);
          if (r != null && typeof r.exit_code !== 'undefined') lines.push('\n(exit ' + r.exit_code + ', ' + (r.provider || '') + ')');
          output.textContent = lines.length ? lines.join('\n') : '(no output)';
        })
        .catch(function (err) {
          if (output) output.textContent = 'Error: ' + (err && (err.message || String(err))) || 'unknown';
        })
        .finally(function () {
          if (btn) btn.disabled = false;
        });
    } catch (e) {
      if (output) output.textContent = 'Error: ' + (e && (e.message || String(e))) || 'unknown';
      btn.disabled = false;
    }
  });

  (function checkMe() {
    const token = getToken();
    if (!token) {
      showAuth();
      return;
    }
    invoke('auth_me', { access_token: token })
      .then(function (data) {
        if (data && data.user) showMe(data.user.email);
        else showAuth();
      })
      .catch(function () {
        setToken(null);
        showAuth();
      });
  })();
})();
