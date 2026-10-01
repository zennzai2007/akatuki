/* YUマーケット
   山口大学の学内で不要になった物を無償でゆずりあうサイト。
   データはすべて Supabase に保存する。端末に残るのはログイン状態だけで、
   それは supabase-js が認証トークンを保存しているもの。 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------
     データ
  ------------------------------------------------------------------ */
  var OPTIONS = {
    category: ["家具", "家電", "教科書", "その他"],
    condition: ["未使用に近い", "目立った傷なし", "やや傷や汚れあり", "傷や汚れあり", "書き込みあり"],
    period: ["今週中", "今月中", "相談可"],
    pickup: ["大学構内", "最寄り駅", "学生寮"],
    campus: ["吉田", "常盤", "小串"]
  };

  // 検索画面の絞り込み項目（ワイヤーフレームの並び）。
  var FILTERS = [
    { key: "category", label: "カテゴリー" },
    { key: "pickup", label: "受取場所" },
    { key: "period", label: "取引可能期間" },
    { key: "campus", label: "キャンパス" }
  ];

  var MAX_PHOTO_SIDE = 1024;

  // iPhone の写真（HEIC）を読めないブラウザ向けの変換ライブラリ。必要になったときだけ読み込む。
  var HEIC_CONVERTER_URL = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";

  var LISTING_STATUS = { open: "出品中", reserved: "取引中", done: "譲渡済み", cancelled: "取消済み" };

  // 同時に進められる取引の上限（申込中＋取引中）。DB 側のポリシーでも同じ数で止めている。
  var MAX_ACTIVE_APPLICATIONS = 3;
  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var UNIVERSITY_EMAIL = /@yamaguchi-u\.ac\.jp$/i;

  // window.supabase はライブラリ本体。接続先は config.js。
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /* ------------------------------------------------------------------
     共通ヘルパー
  ------------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }

  function setError(input, output, message) {
    if (output) output.textContent = message || "";
    if (input) input.classList.toggle("invalid", Boolean(message));
    return !message;
  }

  function go(hash) {
    if (window.location.hash === hash) route();
    else window.location.hash = hash;
  }

  var toastTimer = null;
  function toast(text) {
    var box = $("toast");
    box.textContent = text;
    box.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      box.classList.remove("show");
    }, 2400);
  }

  function showLoginNote(text) {
    var note = $("login-note");
    note.textContent = text;
    note.hidden = !text;
  }

  function formatDate(value) {
    if (!value) return "";
    var parts = String(value).split("-");
    if (parts.length !== 3) return value;
    return Number(parts[0]) + "年" + Number(parts[1]) + "月" + Number(parts[2]) + "日";
  }

  // Date（または created_at の文字列）を、この端末の日付で "YYYY-MM-DD" にする。
  function dateOf(value) {
    var date = new Date(value);
    var month = String(date.getMonth() + 1);
    var day = String(date.getDate());
    return date.getFullYear() + "-" + (month.length < 2 ? "0" + month : month) + "-" + (day.length < 2 ? "0" + day : day);
  }

  function today() {
    return dateOf(new Date());
  }

  function setPhoto(element, url) {
    element.style.backgroundImage = url ? "url(" + JSON.stringify(url) + ")" : "";
  }

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var source = URL.createObjectURL(blob);
      var image = new Image();
      image.onload = function () {
        URL.revokeObjectURL(source);
        resolve(image);
      };
      image.onerror = function () {
        URL.revokeObjectURL(source);
        reject(new Error("画像を読み込めませんでした"));
      };
      image.src = source;
    });
  }

  // 拡張子や MIME が付いていないこともあるので、中身の先頭（ftyp ボックス）でも判定する。
  async function isHeic(file) {
    if (/\.hei[cf]$/i.test(file.name || "") || /hei[cf]/i.test(file.type)) return true;
    var bytes = new Uint8Array(await file.slice(4, 12).arrayBuffer());
    return /^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(String.fromCharCode.apply(null, bytes));
  }

  var heicConverter = null;
  function loadHeicConverter() {
    if (!heicConverter) {
      heicConverter = new Promise(function (resolve, reject) {
        var script = document.createElement("script");
        script.src = HEIC_CONVERTER_URL;
        script.onload = function () { resolve(window.heic2any); };
        script.onerror = function () {
          heicConverter = null;
          reject(new Error("変換ライブラリを読み込めませんでした"));
        };
        document.head.appendChild(script);
      });
    }
    return heicConverter;
  }

  // スマホの写真はそのままだと重いので、長辺 1024px・品質 0.8 の JPEG に縮める。
  async function resizeImage(file) {
    var image;
    try {
      image = await loadImage(file);
    } catch (error) {
      // iPhone の HEIC 写真は Windows の Chrome などでは読めないので、JPEG に変換してから読む。
      if (!(await isHeic(file))) throw error;
      toast("写真を変換しています…");
      var heic2any = await loadHeicConverter();
      var converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
      image = await loadImage(Array.isArray(converted) ? converted[0] : converted);
    }

    var scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    var context = canvas.getContext("2d");
    // 透過 PNG は JPEG にすると黒くなるので、白で下地を塗っておく。
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("画像を変換できませんでした"));
      }, "image/jpeg", 0.8);
    });
  }

  // 出品を消したときに、Storage に残る写真も消す。権限が無い場合は写真だけ残る。
  async function removePhoto(url) {
    var path = String(url || "").split("/object/public/photos/")[1];
    if (!path) return;
    try {
      await sb.storage.from("photos").remove([path]);
    } catch (error) {
      /* 消せなくても出品の削除は済んでいるので続行する */
    }
  }

  // Storage の photos/<自分のid>/ に上げて、公開 URL を返す。
  async function uploadPhoto(blob) {
    var path = cache.me + "/" + Date.now() + ".jpg";
    var result = await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" });
    if (result.error) throw result.error;
    return sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
  }

  /* ------------------------------------------------------------------
     保存データ
  ------------------------------------------------------------------ */
  // Supabase から読んだデータをメモリに持つ。描画は同期のまま cache を読み、
  // ログイン直後と書き込みの後に refresh() で入れ直す。
  var cache = { me: null, profiles: {}, listings: [], applications: [], ratings: [] };

  function refresh() {
    return Promise.all([
      sb.from("profiles").select("*"),
      sb.from("listings").select("*").order("created_at", { ascending: false }),
      sb.from("applications").select("*").order("created_at", { ascending: false }),
      // RLS で自分が付けた評価だけが返る（他人の評価は件数だけ RPC で見る）。
      sb.from("ratings").select("*")
    ]).then(function (results) {
      results.forEach(function (result) {
        if (result.error) throw result.error;
      });
      cache.profiles = {};
      results[0].data.forEach(function (row) { cache.profiles[row.id] = row; });
      cache.listings = results[1].data;
      cache.applications = results[2].data;
      cache.ratings = results[3].data;
    });
  }

  // 評価の合計はほかの人の分も見えないといけないので、RPC で件数だけもらう。
  async function showRating(elementId, userId) {
    var element = $(elementId);
    element.textContent = "読み込み中…";
    var result;
    try {
      result = await sb.rpc("rating_summary", { user_id: userId });
    } catch (error) {
      result = { error: error };
    }
    if (result.error || !result.data) {
      element.textContent = "読み込めませんでした";
      return;
    }
    var total = result.data.total || 0;
    element.textContent = total
      ? "よかった " + (result.data.good || 0) + " / " + total + "件"
      : "まだ評価はありません";
  }

  function myRatingOf(applicationId) {
    return cache.ratings.filter(function (item) { return item.application_id === applicationId; })[0] || null;
  }

  // 読み込みに失敗してもログイン状態は保ち、再読み込みで取り直せるようにする。
  async function enter(session) {
    cache.me = session.user.id;
    try {
      await refresh();
    } catch (error) {
      toast("データを読み込めませんでした。再読み込みしてください");
    }
  }

  function leave() {
    cache.me = null;
    cache.profiles = {};
    cache.listings = [];
    cache.applications = [];
    cache.ratings = [];
    go("#/login");
  }

  var store = {
    profile: function () {
      return cache.profiles[cache.me] || { id: cache.me, name: "", faculty: "", campus: "", photo_url: null };
    },
    listings: function () { return cache.listings; },
    applications: function () { return cache.applications; }
  };

  // cache.listings は新しい順。取消・譲渡済みも含むので、探す画面では openProducts() を使う。
  function allProducts() {
    return store.listings();
  }

  function openProducts() {
    return allProducts().filter(function (item) { return item.status === "open"; });
  }

  function myListings() {
    return allProducts().filter(function (item) { return item.owner_id === cache.me; });
  }

  // 自分の出品は探す画面には出さない（「出品中の商品」から見る）。
  function browsableProducts() {
    return openProducts().filter(function (item) { return item.owner_id !== cache.me; });
  }

  function productById(id) {
    var found = allProducts().filter(function (item) { return String(item.id) === String(id); });
    return found[0] || null;
  }

  function listingOf(application) {
    return allProducts().filter(function (item) { return item.id === application.listing_id; })[0] || null;
  }

  // cache.applications には RLS で「自分の申込」と「自分の出品への申込」だけが入っている。
  function applicationsBy(status) {
    return store.applications().filter(function (item) {
      return item.status === status && item.applicant_id === cache.me;
    });
  }

  // 自分がまだ終えていない申し込み（申込中・取引中）。
  function activeApplications() {
    return store.applications().filter(function (item) {
      return item.applicant_id === cache.me && (item.status === "申込中" || item.status === "取引中");
    });
  }

  function receivedApplications() {
    return store.applications().filter(function (item) {
      var listing = listingOf(item);
      return listing && listing.owner_id === cache.me && item.applicant_id !== cache.me;
    });
  }

  function historyApplications() {
    return store.applications().filter(function (item) {
      var listing = listingOf(item);
      return item.status === "取引完了" && (item.applicant_id === cache.me || (listing && listing.owner_id === cache.me));
    });
  }

  function personLabel(id) {
    var profile = cache.profiles[id] || {};
    return [
      profile.name || "名前未設定",
      profile.faculty,
      profile.campus ? profile.campus + "キャンパス" : ""
    ].filter(Boolean).join("・");
  }

  /* ------------------------------------------------------------------
     商品カード
  ------------------------------------------------------------------ */
  function makeCard(item) {
    var card = document.createElement("button");
    card.type = "button";
    card.className = "card";

    var thumb = document.createElement("div");
    thumb.className = "thumb";
    setPhoto(thumb, item.photo_url);
    card.appendChild(thumb);

    var name = document.createElement("p");
    name.className = "name";
    name.textContent = item.name;
    card.appendChild(name);

    var meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = item.category + "・" + item.campus;
    card.appendChild(meta);

    card.addEventListener("click", function () { go("#/item/" + item.id); });
    return card;
  }

  // 丸い画像＋4行のカード。
  function makeResultCard(item, prefix) {
    var card = document.createElement("button");
    card.type = "button";
    card.className = "result-card";

    var round = document.createElement("div");
    round.className = "round";
    setPhoto(round, item.photo_url);
    card.appendChild(round);

    var lines = document.createElement("div");
    lines.className = "lines";
    [item.name, item.category, item.period, item.campus].forEach(function (text, index) {
      var line = document.createElement("span");
      if (index > 0) line.className = "sub";
      line.textContent = text || "—";
      lines.appendChild(line);
    });
    card.appendChild(lines);

    card.addEventListener("click", function () { go((prefix || "#/item/") + item.id); });
    return card;
  }

  function fillGrid(grid, empty, items) {
    grid.innerHTML = "";
    items.forEach(function (item) { grid.appendChild(makeCard(item)); });
    empty.hidden = items.length > 0;
  }

  /* ------------------------------------------------------------------
     「▽」で開いて複数選べる絞り込み（出品の検索・欲しいですの検索）
  ------------------------------------------------------------------ */
  function filterGroup(container, onChange) {
    var selected = {};
    var panels = {};
    var counters = {};

    FILTERS.forEach(function (filter) {
      selected[filter.key] = [];

      var wrap = document.createElement("div");
      wrap.className = "filter";

      var toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "filter-toggle";
      toggle.innerHTML = "<span></span><span class=\"caret\">▽</span><span class=\"count\"></span>";
      toggle.firstChild.textContent = filter.label;
      wrap.appendChild(toggle);

      var panel = document.createElement("div");
      panel.className = "filter-panel";
      panel.hidden = true;

      OPTIONS[filter.key].forEach(function (value) {
        var label = document.createElement("label");
        var box = document.createElement("input");
        box.type = "checkbox";
        box.value = value;
        box.addEventListener("change", function () {
          var list = selected[filter.key];
          var index = list.indexOf(value);
          if (box.checked && index < 0) list.push(value);
          if (!box.checked && index >= 0) list.splice(index, 1);
          changed();
        });
        label.appendChild(box);
        label.appendChild(document.createTextNode(value));
        panel.appendChild(label);
      });

      toggle.addEventListener("click", function () { panel.hidden = !panel.hidden; });

      wrap.appendChild(panel);
      container.appendChild(wrap);
      panels[filter.key] = panel;
      counters[filter.key] = toggle.querySelector(".count");
    });

    function changed() {
      FILTERS.forEach(function (filter) {
        var count = selected[filter.key].length;
        counters[filter.key].textContent = count ? "（" + count + "）" : "";
      });
      if (onChange) onChange();
    }

    function matches(item, keyword) {
      if (keyword) {
        var haystack = [item.name, item.category, item.color, item.description].join(" ");
        if (haystack.indexOf(keyword) < 0) return false;
      }
      return FILTERS.every(function (filter) {
        var list = selected[filter.key];
        return list.length === 0 || list.indexOf(item[filter.key]) >= 0;
      });
    }

    // 「その他」のように複数の項目で同じ選択肢名が使われるため、
    // チェックを外す対象はその項目のパネル内だけに限定する。
    function clear(key, value) {
      var list = selected[key];
      var index = list.indexOf(value);
      if (index >= 0) list.splice(index, 1);
      each(panels[key].querySelectorAll('input[type="checkbox"]'), function (box) {
        if (box.value === value) box.checked = false;
      });
      changed();
    }

    function active() {
      var list = [];
      FILTERS.forEach(function (filter) {
        selected[filter.key].forEach(function (value) {
          list.push({ key: filter.key, label: filter.label, value: value });
        });
      });
      return list;
    }

    return { matches: matches, clear: clear, active: active };
  }

  function makeChip(text, onRemove) {
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.innerHTML = "<span></span><span class=\"x\">×</span>";
    chip.firstChild.textContent = text;
    chip.addEventListener("click", onRemove);
    return chip;
  }

  function fillChips(container, keyword, filters, onKeyword, onRender) {
    container.innerHTML = "";
    var any = false;

    if (keyword) {
      any = true;
      container.appendChild(makeChip(keyword, function () {
        onKeyword("");
        onRender();
      }));
    }

    filters.active().forEach(function (entry) {
      any = true;
      container.appendChild(makeChip(entry.label + "：" + entry.value, function () {
        filters.clear(entry.key, entry.value);
        onRender();
      }));
    });

    container.hidden = !any;
  }

  /* ------------------------------------------------------------------
     「＋」で開いて1つだけ選ぶ入力（出品フォーム・欲しいです投稿フォーム）
  ------------------------------------------------------------------ */
  function pickerGroup(form) {
    var values = {};
    var fields = {};

    each(form.querySelectorAll(".sell-field[data-key]"), function (field) {
      var key = field.getAttribute("data-key");
      var button = field.querySelector(".picker");
      var panel = field.querySelector(".picker-panel");
      values[key] = "";
      fields[key] = field;

      OPTIONS[key].forEach(function (value) {
        var label = document.createElement("label");
        var radio = document.createElement("input");
        radio.type = "radio";
        radio.name = form.id + "-" + key;
        radio.value = value;
        radio.addEventListener("change", function () {
          values[key] = value;
          button.querySelector(".chosen").textContent = value;
          panel.hidden = true;
          setError(null, field.querySelector(".error"), "");
        });
        label.appendChild(radio);
        label.appendChild(document.createTextNode(value));
        panel.appendChild(label);
      });

      button.addEventListener("click", function () { panel.hidden = !panel.hidden; });
    });

    function validate() {
      var ok = true;
      Object.keys(fields).forEach(function (key) {
        var field = fields[key];
        if (values[key]) return;
        var label = field.querySelector(".picker span").textContent;
        setError(null, field.querySelector(".error"), label + "を選んでください");
        ok = false;
      });
      return ok;
    }

    function reset() {
      Object.keys(fields).forEach(function (key) {
        var field = fields[key];
        values[key] = "";
        each(field.querySelectorAll(".picker-panel input"), function (radio) {
          radio.checked = false;
        });
        field.querySelector(".chosen").textContent = "＋";
        field.querySelector(".picker-panel").hidden = true;
        setError(null, field.querySelector(".error"), "");
      });
    }

    return { values: values, validate: validate, reset: reset };
  }

  /* ------------------------------------------------------------------
     ログイン / 新規登録
  ------------------------------------------------------------------ */
  (function auth() {
    var loginForm = $("login-form");
    var email = $("login-email");
    var password = $("login-password");

    function loginErrorMessage(error) {
      if (error.code === "email_not_confirmed" || /not confirmed/i.test(error.message)) {
        return "メールアドレスの確認が済んでいません。確認メールのリンクを開いてください";
      }
      if (error.code === "invalid_credentials" || /invalid login credentials/i.test(error.message)) {
        return "メールアドレスまたはパスワードが正しくありません";
      }
      return "ログインできませんでした。通信状況を確認して、もう一度お試しください";
    }

    function signupErrorMessage(error) {
      // ドメイン制限はDBのトリガーで弾くため、Supabase からは汎用のエラーしか返らない。
      if (/database error saving new user/i.test(error.message)) {
        return "登録できませんでした。山口大学のメールアドレスか確認してください";
      }
      if (error.code === "user_already_exists") return "このメールアドレスは登録済みです";
      if (error.code === "weak_password") return "推測されやすいパスワードです。別のパスワードにしてください";
      if (error.code === "over_email_send_rate_limit" || error.status === 429) {
        return "確認メールの送信が混み合っています。しばらく待ってからお試しください";
      }
      return "登録できませんでした。通信状況を確認して、もう一度お試しください";
    }

    loginForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var address = email.value.trim();
      var okEmail = address
        ? (EMAIL_PATTERN.test(address)
          ? setError(email, $("login-email-error"), "")
          : setError(email, $("login-email-error"), "メールアドレスの形式が正しくありません"))
        : setError(email, $("login-email-error"), "メールアドレスを入力してください");
      var okPassword = password.value
        ? setError(password, $("login-password-error"), "")
        : setError(password, $("login-password-error"), "パスワードを入力してください");
      if (!okEmail || !okPassword) return;

      var button = loginForm.querySelector('[type="submit"]');
      button.disabled = true;
      var result = await sb.auth.signInWithPassword({ email: address, password: password.value })
        .catch(function (error) { return { error: error }; });
      if (result.error) {
        button.disabled = false;
        setError(password, $("login-password-error"), loginErrorMessage(result.error));
        return;
      }

      password.value = "";
      showLoginNote("");
      await enter(result.data.session);
      button.disabled = false;
      go("#/home");
    });

    var signupForm = $("signup-form");
    var newEmail = $("signup-email");
    var newPassword = $("signup-password");
    var confirmPassword = $("signup-confirm");

    signupForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var address = newEmail.value.trim();
      var okEmail = !address
        ? setError(newEmail, $("signup-email-error"), "メールアドレスを入力してください")
        : !EMAIL_PATTERN.test(address)
          ? setError(newEmail, $("signup-email-error"), "メールアドレスの形式が正しくありません")
          : !UNIVERSITY_EMAIL.test(address)
            ? setError(newEmail, $("signup-email-error"), "山口大学のメールアドレスで登録してください")
            : setError(newEmail, $("signup-email-error"), "");
      var okPassword = newPassword.value.length >= 8
        ? setError(newPassword, $("signup-password-error"), "")
        : setError(newPassword, $("signup-password-error"), "パスワードは8文字以上で入力してください");
      var okConfirm = confirmPassword.value === newPassword.value
        ? setError(confirmPassword, $("signup-confirm-error"), "")
        : setError(confirmPassword, $("signup-confirm-error"), "パスワードが一致しません");
      if (!okEmail || !okPassword || !okConfirm) return;

      var button = signupForm.querySelector('[type="submit"]');
      button.disabled = true;
      var result = await sb.auth.signUp({
        email: address,
        password: newPassword.value,
        // 開いているサイト（公開版かローカル）へ戻す。Supabase の Redirect URLs に無い場合は Site URL へ戻る。
        options: { emailRedirectTo: window.location.origin + window.location.pathname }
      }).catch(function (error) { return { error: error }; });
      button.disabled = false;

      if (result.error) {
        if (result.error.code === "weak_password") {
          setError(newPassword, $("signup-password-error"), signupErrorMessage(result.error));
        } else {
          setError(newEmail, $("signup-email-error"), signupErrorMessage(result.error));
        }
        return;
      }

      // 確認メールが有効なとき、登録済みのアドレスはエラーにならず identities が空で返る。
      var user = result.data.user;
      if (user && user.identities && user.identities.length === 0) {
        setError(newEmail, $("signup-email-error"), "このメールアドレスは登録済みです");
        return;
      }

      newPassword.value = "";
      confirmPassword.value = "";

      // Supabase 側で確認メールをオフにしている場合は、そのままログイン状態で返る。
      if (result.data.session) {
        await enter(result.data.session);
        toast("登録しました");
        go("#/home");
        return;
      }

      showLoginNote("確認メールを送りました。メール内のリンクを開いてください");
      go("#/login");
    });
  })();

  /* ------------------------------------------------------------------
     ホーム
  ------------------------------------------------------------------ */
  var home = (function () {
    var search = $("home-search");
    var categories = $("home-categories");

    OPTIONS.category.forEach(function (value) {
      var label = document.createElement("label");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.value = value;
      box.addEventListener("change", render);
      label.appendChild(box);
      label.appendChild(document.createTextNode(value));
      categories.appendChild(label);
    });

    $("home-search-form").addEventListener("submit", function (event) {
      event.preventDefault();
      results.setKeyword(search.value.trim());
      go("#/results");
    });

    function render() {
      var checked = [];
      each(categories.querySelectorAll("input:checked"), function (box) { checked.push(box.value); });
      var items = browsableProducts().filter(function (item) {
        return checked.length === 0 || checked.indexOf(item.category) >= 0;
      });

      fillGrid($("home-latest"), $("home-latest-empty"), items);
    }

    return { render: render };
  })();

  /* ------------------------------------------------------------------
     検索（絞り込み＋一覧）
  ------------------------------------------------------------------ */
  var search = (function () {
    var input = $("search-input");
    var filters = filterGroup($("search-filters"), function () { render(); });

    $("search-form").addEventListener("submit", function (event) {
      event.preventDefault();
      results.setKeyword(input.value.trim());
      go("#/results");
    });

    function render() {
      fillGrid($("search-results"), $("search-empty"),
        browsableProducts().filter(function (item) {
          return filters.matches(item, input.value.trim());
        }));
    }

    return {
      render: render,
      filters: filters,
      keyword: function () { return input.value.trim(); },
      setKeyword: function (value) { input.value = value; }
    };
  })();

  /* ------------------------------------------------------------------
     検索結果（リスト表示）
  ------------------------------------------------------------------ */
  var results = (function () {
    var keyword = "";

    function setKeyword(value) {
      keyword = value;
      search.setKeyword(value);
    }

    function render() {
      $("results-title").textContent = keyword
        ? "“" + keyword + "”検索結果"
        : "検索結果";

      fillChips($("results-chips"), keyword, search.filters, setKeyword, render);

      var list = $("results-list");
      list.innerHTML = "";
      var items = browsableProducts().filter(function (item) {
        return search.filters.matches(item, keyword);
      });
      items.forEach(function (item) { list.appendChild(makeResultCard(item)); });
      $("results-empty").hidden = items.length > 0;
    }

    return { render: render, setKeyword: setKeyword };
  })();

  /* ------------------------------------------------------------------
     通報（送るだけ。DB でも読み取りは許可せず、運営者がダッシュボードで見る）
  ------------------------------------------------------------------ */
  var REPORT_REASONS = ["販売・金銭の要求", "不適切な写真や内容", "連絡が取れない", "迷惑な行為", "その他"];

  // 通報されたあとに出品や取引が消えても確認できるよう、通報時点の内容をコピーして残す。
  function listingSnapshot(listing) {
    if (!listing) return "";
    return [
      "商品名: " + (listing.name || ""),
      "カテゴリー: " + (listing.category || ""),
      "状態: " + (listing.condition || ""),
      "受け渡し: " + [listing.period, listing.pickup, listing.campus].filter(Boolean).join(" / "),
      "説明: " + (listing.description || ""),
      "写真: " + (listing.photo_url || "なし")
    ].join("\n");
  }

  async function messagesSnapshot(applicationId) {
    if (!applicationId) return "";
    var result;
    try {
      result = await sb.from("messages").select("*")
        .eq("application_id", applicationId)
        .order("created_at", { ascending: true });
    } catch (error) {
      return "";
    }
    if (result.error || !result.data) return "";
    return result.data.map(function (message) {
      var who = cache.profiles[message.sender_id] || {};
      return "[" + dateOf(message.created_at) + "] " + (who.name || "名前未設定") + ": " + message.body;
    }).join("\n");
  }

  // getTarget() は { reportedId, listingId, listingName, listing, applicationId } を返す。
  function attachReport(prefix, getTarget, onSent, question) {
    var open = $(prefix + "-report-open");
    var form = $(prefix + "-report-form");
    var reason = $(prefix + "-report-reason");
    var note = $(prefix + "-report-note");

    REPORT_REASONS.forEach(function (value) {
      var option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      reason.appendChild(option);
    });

    open.addEventListener("click", function () {
      form.hidden = false;
      open.hidden = true;
    });

    $(prefix + "-report-cancel").addEventListener("click", close);

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var target = getTarget();
      if (!target || !target.reportedId) return;
      if (question && !window.confirm(question)) return;

      var button = form.querySelector('[type="submit"]');
      button.disabled = true;
      var result;
      try {
        result = await sb.from("reports").insert({
          reporter_id: cache.me,
          reported_id: target.reportedId,
          listing_id: target.listingId || null,
          listing_name: target.listingName || "",
          application_id: target.applicationId || null,
          listing_detail: listingSnapshot(target.listing),
          messages_snapshot: await messagesSnapshot(target.applicationId),
          reason: reason.value,
          note: note.value.trim()
        });
      } catch (error) {
        result = { error: error };
      }
      button.disabled = false;

      if (result.error) {
        toast("通報できませんでした。もう一度お試しください");
        return;
      }
      close();
      if (onSent) onSent();
      toast("通報しました。確認します");
    });

    function close() {
      form.hidden = true;
      open.hidden = false;
      note.value = "";
      reason.selectedIndex = 0;
    }

    return { close: close };
  }

  /* ------------------------------------------------------------------
     商品詳細
  ------------------------------------------------------------------ */
  var detail = (function () {
    var current = null;

    $("detail-apply").addEventListener("click", function () {
      if (current) go("#/apply/" + current.id);
    });

    var report = attachReport("detail", function () {
      if (!current) return null;
      return {
        reportedId: current.owner_id,
        listingId: current.id,
        listingName: current.name,
        listing: current
      };
    });

    function render(id) {
      var item = productById(id);
      current = item;
      if (!item) {
        go("#/search");
        return;
      }

      $("detail-name").textContent = item.name;
      setPhoto($("detail-photo"), item.photo_url);
      $("detail-description").textContent = item.description || "（説明はありません）";
      $("detail-category").textContent = item.category;
      $("detail-condition").textContent = item.condition;
      $("detail-period").textContent = item.period;
      $("detail-pickup").textContent = item.pickup;
      $("detail-campus").textContent = item.campus;

      $("detail-owner").textContent = personLabel(item.owner_id);
      showRating("detail-owner-rating", item.owner_id);

      var applied = store.applications().some(function (entry) {
        return entry.listing_id === item.id && entry.applicant_id === cache.me
          && (entry.status === "申込中" || entry.status === "取引中");
      });
      var mine = item.owner_id === cache.me;
      var closed = item.status !== "open";
      var stopped = blocked();
      var tooMany = !applied && activeApplications().length >= MAX_ACTIVE_APPLICATIONS;

      var button = $("detail-apply");
      var note = $("detail-note");
      button.disabled = applied || mine || closed || stopped || tooMany;
      note.hidden = !(applied || mine || closed || stopped || tooMany);
      if (mine) note.textContent = "自分の出品です";
      else if (closed) note.textContent = "この商品の受付は終了しました";
      else if (applied) note.textContent = "この商品はすでに申し込み済みです";
      else if (stopped) note.textContent = "利用が停止されています。運営者にお問い合わせください";
      else if (tooMany) note.textContent = "同時に申し込めるのは" + MAX_ACTIVE_APPLICATIONS + "件までです";

      // 自分の出品は通報できない。
      report.close();
      $("detail-report").hidden = mine;
    }

    return { render: render };
  })();

  /* ------------------------------------------------------------------
     申込確認
  ------------------------------------------------------------------ */
  var confirmView = (function () {
    var form = $("confirm-form");
    var date = $("confirm-date");
    var place = $("confirm-place");
    var message = $("confirm-message");
    var agree = $("confirm-agree");
    var current = null;

    var blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "選択してください";
    place.appendChild(blank);
    OPTIONS.pickup.forEach(function (value) {
      var option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      place.appendChild(option);
    });

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!current) return;

      var okDate = !date.value
        ? setError(null, $("confirm-date-error"), "受取可能日を選んでください")
        : (date.value < today()
          ? setError(null, $("confirm-date-error"), "今日以降の日付を選んでください")
          : setError(null, $("confirm-date-error"), ""));
      $("confirm-date-box").classList.toggle("invalid", !okDate);

      var okPlace = place.value
        ? setError(null, $("confirm-place-error"), "")
        : setError(null, $("confirm-place-error"), "受取希望場所を選んでください");
      $("confirm-place-box").classList.toggle("invalid", !okPlace);

      var okMessage = message.value.trim()
        ? setError(null, $("confirm-message-error"), "")
        : setError(null, $("confirm-message-error"), "メッセージを入力してください");
      $("confirm-message-box").classList.toggle("invalid", !okMessage);

      var okAgree = agree.checked
        ? setError(null, $("confirm-agree-error"), "")
        : setError(null, $("confirm-agree-error"), "利用規約への同意が必要です");

      if (!okDate || !okPlace || !okMessage || !okAgree) return;

      if (blocked()) {
        toast("利用が停止されているため申し込めません");
        return;
      }

      if (activeApplications().length >= MAX_ACTIVE_APPLICATIONS) {
        toast("同時に申し込めるのは" + MAX_ACTIVE_APPLICATIONS + "件までです。取引を進めてからお試しください");
        return;
      }

      var button = form.querySelector('[type="submit"]');
      button.disabled = true;
      // supabase-js のクエリは then しか持たないので、.catch ではなく try で受ける。
      var result;
      try {
        result = await sb.from("applications").insert({
          listing_id: current.id,
          applicant_id: cache.me,
          date: date.value,
          place: place.value,
          message: message.value.trim()
        });
      } catch (error) {
        result = { error: error };
      }

      if (result.error) {
        button.disabled = false;
        // 23505: 同じ出品への有効な申込が既にある（one_active_application）
        // 42501: RLS で弾かれた（受付が終わった・自分の出品）
        if (result.error.code === "23505") toast("すでに申込済みです");
        else if (result.error.code === "42501") toast("この商品には申し込めません。画面を再読み込みしてください");
        else toast("申し込めませんでした。通信状況を確認して、もう一度お試しください");
        return;
      }

      try { await refresh(); } catch (error) { /* 次の読み込みで反映される */ }
      button.disabled = false;
      form.reset();
      toast("申し込みました");
      go("#/transactions");
    });

    function render(id) {
      var item = productById(id);
      current = item;
      if (!item) {
        go("#/search");
        return;
      }
      if (item.status !== "open" || item.owner_id === cache.me) {
        go("#/item/" + item.id);
        return;
      }
      setPhoto($("confirm-photo"), item.photo_url);
      date.min = today();
      ["confirm-date-error", "confirm-place-error", "confirm-message-error", "confirm-agree-error"].forEach(function (key) {
        $(key).textContent = "";
      });
      ["confirm-date-box", "confirm-place-box", "confirm-message-box"].forEach(function (key) {
        $(key).classList.remove("invalid");
      });
    }

    return { render: render };
  })();

  /* ------------------------------------------------------------------
     出品
  ------------------------------------------------------------------ */
  // 利用停止中は出品・申込・メッセージができない。DB 側のポリシーでも弾いている。
  function blocked() {
    return Boolean(store.profile().blocked);
  }

  var sell = (function () {
    var form = $("sell-form");
    var name = $("sell-name");
    var description = $("sell-description");
    var photoButton = $("sell-photo");
    var photoInput = $("sell-photo-input");
    var photoRemove = $("sell-photo-remove");
    var photoLabel = $("sell-photo-label");
    var pickers = pickerGroup(form);
    var chosen = pickers.values;
    var photo = null;    // 縮小済みの JPEG（Blob）。出品するときに Storage へ上げる。
    var preview = "";

    function showPhoto(blob) {
      if (preview) URL.revokeObjectURL(preview);
      photo = blob;
      preview = blob ? URL.createObjectURL(blob) : "";
      setPhoto(photoButton, preview);
      photoLabel.hidden = Boolean(blob);
      photoRemove.hidden = !blob;
    }

    photoButton.addEventListener("click", function () { photoInput.click(); });

    photoInput.addEventListener("change", async function () {
      var file = photoInput.files && photoInput.files[0];
      photoInput.value = "";
      if (!file) return;
      try {
        showPhoto(await resizeImage(file));
        setError(null, $("sell-photo-error"), "");
      } catch (error) {
        setError(null, $("sell-photo-error"), "この写真は読み込めませんでした。別の写真をお試しください");
      }
    });

    photoRemove.addEventListener("click", function () { showPhoto(null); });

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      var ok = name.value.trim()
        ? setError(name, $("sell-name-error"), "")
        : setError(name, $("sell-name-error"), "商品名を入力してください");

      if (!pickers.validate()) ok = false;

      if (!description.value.trim()) {
        setError(description, $("sell-description-error"), "商品の説明を入力してください");
        ok = false;
      } else {
        setError(description, $("sell-description-error"), "");
      }

      if (!photo) {
        setError(null, $("sell-photo-error"), "写真を追加してください");
        ok = false;
      }

      if (!$("sell-agree").checked) {
        setError(null, $("sell-agree-error"), "出してはいけないものに当たらないか確認してください");
        ok = false;
      } else {
        setError(null, $("sell-agree-error"), "");
      }

      if (!ok) return;

      if (blocked()) {
        toast("利用が停止されているため出品できません");
        return;
      }

      var button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        var photoUrl = await uploadPhoto(photo);
        var result = await sb.from("listings").insert({
          owner_id: cache.me,
          name: name.value.trim(),
          category: chosen.category,
          condition: chosen.condition,
          period: chosen.period,
          pickup: chosen.pickup,
          campus: chosen.campus,
          description: description.value.trim(),
          photo_url: photoUrl
        });
        if (result.error) throw result.error;
      } catch (error) {
        button.disabled = false;
        toast("出品できませんでした。通信状況を確認して、もう一度お試しください");
        return;
      }

      // 出品自体は済んでいるので、読み直しに失敗しても二重に出品させないよう完了扱いにする。
      try { await refresh(); } catch (error) { /* 次の読み込みで反映される */ }
      button.disabled = false;
      reset();
      toast("出品しました");
      go("#/listings");
    });

    function render() {
      var stopped = blocked();
      $("sell-blocked").hidden = !stopped;
      form.querySelector('[type="submit"]').disabled = stopped;
    }

    function reset() {
      form.reset();
      showPhoto(null);
      pickers.reset();
      each(form.querySelectorAll(".error"), function (box) { box.textContent = ""; });
      $("sell-photo-error").textContent = "";
    }

    return { render: render };
  })();

  /* ------------------------------------------------------------------
     メッセージ（取引中の当事者だけ）
  ------------------------------------------------------------------ */
  var chat = (function () {
    var list = $("chat-list");
    var form = $("chat-form");
    var input = $("chat-input");
    var current = null;
    var timer = null;

    var report = attachReport("chat", function () {
      if (!current) return null;
      var listing = listingOf(current) || {};
      var other = current.applicant_id === cache.me ? listing.owner_id : current.applicant_id;
      return {
        reportedId: other,
        listingId: listing.id,
        listingName: listing.name || "",
        listing: listing,
        applicationId: current.id
      };
    }, function () {
      // 通報したらこの取引のメッセージは止まる。
      setLocked(true);
    }, "通報すると、この取引ではどちらもメッセージを送れなくなります。通報しますか？");

    // 通報されているかは reports を読めないので RPC で聞く。
    async function checkLocked(applicationId) {
      var result;
      try {
        result = await sb.rpc("trade_reported", { app_id: applicationId });
      } catch (error) {
        return;
      }
      if (!result.error && result.data && current && current.id === applicationId) setLocked(true);
    }

    function setLocked(locked) {
      form.hidden = locked;
      $("chat-locked").hidden = !locked;
    }

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var body = input.value.trim();
      if (!current || !body) return;

      if (blocked()) {
        toast("利用が停止されているため送信できません");
        return;
      }

      var button = form.querySelector('[type="submit"]');
      button.disabled = true;
      var result;
      try {
        result = await sb.from("messages").insert({
          application_id: current.id,
          sender_id: cache.me,
          body: body
        });
      } catch (error) {
        result = { error: error };
      }
      button.disabled = false;

      if (result.error) {
        // 通報された取引では DB 側が拒否する。
        if (result.error.code === "42501") {
          setLocked(true);
          toast("この取引は通報されたため、メッセージを送れません");
        } else {
          toast("送信できませんでした。もう一度お試しください");
        }
        return;
      }
      input.value = "";
      await load();
    });

    async function load() {
      if (!current) return;
      var result;
      try {
        result = await sb.from("messages").select("*")
          .eq("application_id", current.id)
          .order("created_at", { ascending: true });
      } catch (error) {
        result = { error: error };
      }
      if (result.error || !result.data) return;
      draw(result.data);
    }

    function draw(messages) {
      list.innerHTML = "";
      messages.forEach(function (message) {
        var row = document.createElement("div");
        row.className = "chat-message" + (message.sender_id === cache.me ? " mine" : "");

        var who = document.createElement("p");
        who.className = "chat-who";
        who.textContent = message.sender_id === cache.me ? "自分" : personLabel(message.sender_id);
        row.appendChild(who);

        var body = document.createElement("p");
        body.className = "chat-body";
        body.textContent = message.body;
        row.appendChild(body);

        list.appendChild(row);
      });
      $("chat-empty").hidden = messages.length > 0;
      list.scrollTop = list.scrollHeight;
    }

    function render(id) {
      var entry = store.applications().filter(function (item) { return item.id === id; })[0];
      // 取引中の当事者だけが使える。RLS でも同じ条件で弾いている。
      if (!entry || entry.status !== "取引中") {
        go("#/transactions");
        return;
      }

      current = entry;
      var listing = listingOf(entry) || {};
      var other = entry.applicant_id === cache.me ? listing.owner_id : entry.applicant_id;
      $("chat-title").textContent = listing.name || "メッセージ";
      $("chat-partner").textContent = personLabel(other);
      list.innerHTML = "";
      $("chat-empty").hidden = true;
      input.value = "";
      report.close();
      setLocked(false);
      checkLocked(entry.id);

      load();
      // 通知の仕組みは無いので、開いている間だけ新着と通報の有無を取りに行く。
      timer = window.setInterval(function () {
        load();
        if (current) checkLocked(current.id);
      }, 10000);
    }

    function stop() {
      if (timer) window.clearInterval(timer);
      timer = null;
      current = null;
    }

    return { render: render, stop: stop };
  })();

  /* ------------------------------------------------------------------
     取引（届いた申込・申込中・取引中・履歴）/ 出品中
  ------------------------------------------------------------------ */
  function makeEntryCard(entry, lines, actions) {
    var card = document.createElement("div");
    card.className = "app-card";

    var thumb = document.createElement("div");
    thumb.className = "thumb";
    setPhoto(thumb, entry.photo_url);
    card.appendChild(thumb);

    var body = document.createElement("div");
    body.className = "body";
    lines.forEach(function (line, index) {
      var p = document.createElement("p");
      if (index > 0) p.className = "sub";
      p.textContent = line;
      body.appendChild(p);
    });

    if (entry.status) {
      var status = document.createElement("span");
      status.className = "status";
      status.textContent = entry.status;
      body.appendChild(status);
    }

    if (actions && actions.length) {
      var row = document.createElement("div");
      row.className = "card-actions";
      actions.forEach(function (action) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "mini-button";
        button.textContent = action.label;
        button.addEventListener("click", action.run);
        row.appendChild(button);
      });
      body.appendChild(row);
    }

    card.appendChild(body);
    return card;
  }

  function renderEntryList(listId, emptyId, entries, build) {
    var list = $(listId);
    list.innerHTML = "";
    entries.forEach(function (entry) { list.appendChild(build(entry)); });
    $(emptyId).hidden = entries.length > 0;
  }

  // 状態を変える操作は RPC だけで行う（applications.status はクライアントから更新できない）。
  async function changeApplication(rpc, application, button, question, doneText, rerender) {
    if (!window.confirm(question)) return;
    button.disabled = true;
    var result;
    try {
      result = await sb.rpc(rpc, { app_id: application.id });
    } catch (error) {
      result = { error: error };
    }
    if (result.error) {
      button.disabled = false;
      toast(/not allowed/i.test(result.error.message || "")
        ? "この操作はできませんでした。画面を再読み込みしてください"
        : "通信に失敗しました。もう一度お試しください");
      return;
    }
    try { await refresh(); } catch (error) { /* 次の読み込みで反映される */ }
    toast(doneText);
    rerender();
    renderBadges();
  }

  // 申込者側のカード。写真と商品名は出品から引く。
  function applicationCard(entry, lines, actions) {
    var listing = listingOf(entry) || {};
    return makeEntryCard(Object.assign({}, entry, { photo_url: listing.photo_url }),
      [listing.name || "（商品が見つかりません）"].concat(lines), actions);
  }

  function renderApplications() {
    renderEntryList("applications-list", "applications-empty", applicationsBy("申込中"), function (entry) {
      return applicationCard(entry, [
        "申込日　" + formatDate(dateOf(entry.created_at)),
        "希望日　" + formatDate(entry.date)
      ], [
        {
          label: "申し込みを取り消す",
          run: function (event) {
            changeApplication("cancel_application", entry, event.currentTarget,
              "この申し込みを取り消しますか？", "申し込みを取り消しました", renderTransactions);
          }
        }
      ]);
    });
  }

  function renderDeals() {
    renderEntryList("deals-list", "deals-empty", applicationsBy("取引中"), function (entry) {
      return applicationCard(entry, [
        "受取日　" + formatDate(entry.date),
        "受取場所　" + entry.place,
        "出品者が完了処理をすると履歴に移ります"
      ], [
        {
          label: "メッセージ",
          run: function () { go("#/chat/" + entry.id); }
        }
      ]);
    });
  }

  // 受け取った人だけが、取引ごとに1回、出品者を評価できる。
  async function rate(entry, good, button) {
    button.disabled = true;
    var listing = listingOf(entry) || {};
    var result;
    try {
      result = await sb.from("ratings").insert({
        application_id: entry.id,
        rater_id: cache.me,
        rated_id: listing.owner_id,
        good: good
      });
    } catch (error) {
      result = { error: error };
    }
    if (result.error) {
      button.disabled = false;
      toast("評価できませんでした。もう一度お試しください");
      return;
    }
    try { await refresh(); } catch (error) { /* 次の読み込みで反映される */ }
    toast("評価しました");
    renderTransactions();
  }

  function renderHistory() {
    renderEntryList("history-list", "history-empty", historyApplications(), function (entry) {
      var mine = entry.applicant_id === cache.me;
      var rating = myRatingOf(entry.id);
      var lines = [
        "取引完了日　" + formatDate(dateOf(entry.completed_at || entry.created_at)),
        mine ? "ゆずってもらいました" : "ゆずりました"
      ];
      var actions = [];

      if (mine && rating) {
        lines.push("評価　" + (rating.good ? "よかった" : "困った"));
      } else if (mine) {
        lines.push("出品者はどうでしたか？");
        actions = [
          {
            label: "よかった",
            run: function (event) { rate(entry, true, event.currentTarget); }
          },
          {
            label: "困った",
            run: function (event) { rate(entry, false, event.currentTarget); }
          }
        ];
      }

      return applicationCard(entry, lines, actions);
    });
  }

  // 取引の画面は、届いた申込・申込中・取引中・履歴をまとめて描き直す。
  function renderTransactions() {
    renderReceived();
    renderApplications();
    renderDeals();
    renderHistory();
    renderBadges();
  }

  // 出品者側: 自分の出品に届いた申込。
  function renderReceived() {
    var entries = receivedApplications().filter(function (item) {
      return item.status === "申込中" || item.status === "取引中";
    });
    renderEntryList("received-list", "received-empty", entries, function (entry) {
      return receivedCard(entry, listingOf(entry) || {});
    });
  }

  function receivedCard(entry, listing) {
    var lines = [listing.name || "（商品が見つかりません）", personLabel(entry.applicant_id)];
    var actions;

    if (entry.status === "申込中") {
      lines.push(
        "希望日　" + formatDate(entry.date),
        "希望場所　" + entry.place,
        "メッセージ　" + (entry.message || "")
      );
      actions = [
        {
          label: "承認する",
          run: function (event) {
            changeApplication("approve_application", entry, event.currentTarget,
              "承認すると、この出品へのほかの申込は自動で取り消されます。承認しますか？",
              "承認しました", renderTransactions);
          }
        },
        {
          label: "断る",
          run: function (event) {
            changeApplication("cancel_application", entry, event.currentTarget,
              "この申込を断りますか？", "申込を断りました", renderTransactions);
          }
        }
      ];
    } else {
      lines.push(
        "受取日　" + formatDate(entry.date),
        "受取場所　" + entry.place
      );
      actions = [
        {
          label: "メッセージ",
          run: function () { go("#/chat/" + entry.id); }
        },
        {
          label: "受け渡し完了",
          run: function (event) {
            changeApplication("complete_application", entry, event.currentTarget,
              "受け渡しは済みましたか？完了にすると元に戻せません。", "取引が完了しました", renderTransactions);
          }
        },
        {
          label: "取り消す",
          run: function (event) {
            changeApplication("cancel_application", entry, event.currentTarget,
              "この取引を取り消しますか？出品は受付中に戻ります。", "取引を取り消しました", renderTransactions);
          }
        }
      ];
    }

    return makeEntryCard(Object.assign({}, entry, { photo_url: listing.photo_url }), lines, actions);
  }

  function renderListings() {
    renderEntryList("listings-list", "listings-empty", myListings(), function (entry) {
      var actions = [
        {
          label: "商品ページを見る",
          run: function () { go("#/item/" + entry.id); }
        }
      ];

      // 取引中の出品は申込側と状態がずれるので、取り消せるのは受付中のものだけ。
      // 以前の版で「取消済み」にした出品も、ここから消せるようにしておく。
      if (entry.status === "open" || entry.status === "cancelled") {
        actions.push({
          label: entry.status === "open" ? "出品を取り消す" : "データを消す",
          run: async function (event) {
            var question = entry.status === "open"
              ? "「" + entry.name + "」の出品を取り消しますか？\n出品・写真・届いている申し込みは完全に消え、元に戻せません。"
              : "「" + entry.name + "」のデータを消しますか？\n元に戻せません。";
            if (!window.confirm(question)) return;
            var button = event.currentTarget;
            button.disabled = true;
            var result = await sb.from("listings").delete().eq("id", entry.id).select();
            if (result.error || !result.data || !result.data.length) {
              button.disabled = false;
              toast("取り消せませんでした。もう一度お試しください");
              return;
            }
            await removePhoto(entry.photo_url);
            try { await refresh(); } catch (error) { /* 次の読み込みで反映される */ }
            toast(entry.status === "open" ? "出品を取り消しました" : "データを消しました");
            renderListings();
            renderBadges();
          }
        });
      }

      return makeEntryCard(Object.assign({}, entry, { status: LISTING_STATUS[entry.status] }), [
        entry.name,
        "出品日　" + formatDate(dateOf(entry.created_at)),
        entry.category + "・" + entry.campus
      ], actions);
    });
  }

  function renderBadges() {
    $("badge-listings").textContent = countLabel(myListings().filter(function (item) {
      return item.status === "open";
    }).length);
    $("badge-transactions").textContent = countLabel(
      receivedApplications().filter(function (item) {
        return item.status === "申込中" || item.status === "取引中";
      }).length + applicationsBy("申込中").length + applicationsBy("取引中").length
    );
  }

  function countLabel(count) {
    return count ? count + "件" : "";
  }

  /* ------------------------------------------------------------------
     プロフィール
  ------------------------------------------------------------------ */
  var mypage = (function () {
    var form = $("mypage-form");
    var view = $("mypage-view");
    var avatar = $("mypage-avatar");
    var avatarInput = $("mypage-avatar-input");
    var campusSelect = $("mypage-input-campus");

    var blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "選択してください";
    campusSelect.appendChild(blank);
    OPTIONS.campus.forEach(function (value) {
      var option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      campusSelect.appendChild(option);
    });

    avatar.addEventListener("click", function () { avatarInput.click(); });

    avatarInput.addEventListener("change", async function () {
      var file = avatarInput.files && avatarInput.files[0];
      avatarInput.value = "";
      if (!file) return;
      avatar.disabled = true;
      try {
        var url = await uploadPhoto(await resizeImage(file));
        var result = await sb.from("profiles").update({ photo_url: url }).eq("id", cache.me).select();
        if (result.error || !result.data || !result.data.length) throw result.error || new Error("更新できませんでした");
        cache.profiles[cache.me] = result.data[0];
      } catch (error) {
        avatar.disabled = false;
        toast("プロフィール画像を保存できませんでした");
        return;
      }
      try { await refresh(); } catch (error) { /* 保存済みの行を表示する */ }
      avatar.disabled = false;
      setPhoto(avatar, store.profile().photo_url);
      toast("プロフィール画像を変更しました");
    });

    $("mypage-edit").addEventListener("click", function () { setEditing(true); });
    $("mypage-cancel").addEventListener("click", function () { setEditing(false); });

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var name = $("mypage-input-name");
      var faculty = $("mypage-input-faculty");

      var okName = name.value.trim()
        ? setError(name, $("mypage-name-error"), "")
        : setError(name, $("mypage-name-error"), "名前を入力してください");
      var okFaculty = faculty.value.trim()
        ? setError(faculty, $("mypage-faculty-error"), "")
        : setError(faculty, $("mypage-faculty-error"), "学部を入力してください");
      var okCampus = campusSelect.value
        ? setError(campusSelect, $("mypage-campus-error"), "")
        : setError(campusSelect, $("mypage-campus-error"), "キャンパスを選んでください");
      if (!okName || !okFaculty || !okCampus) return;

      var button = form.querySelector('[type="submit"]');
      button.disabled = true;
      // RLS で弾かれた更新はエラーにならず0件で返るので、select() で更新できた行を確かめる。
      var result = await sb.from("profiles")
        .update({ name: name.value.trim(), faculty: faculty.value.trim(), campus: campusSelect.value })
        .eq("id", cache.me)
        .select();
      var saved = result.data && result.data[0];
      if (result.error || !saved) {
        button.disabled = false;
        toast("保存できませんでした。もう一度お試しください");
        return;
      }
      try {
        await refresh();
      } catch (error) {
        cache.profiles[cache.me] = saved;
      }
      button.disabled = false;
      setEditing(false);
      render();
      toast("プロフィールを保存しました");
    });

    function setEditing(editing) {
      form.hidden = !editing;
      view.hidden = editing;
      if (editing) {
        var profile = store.profile();
        $("mypage-input-name").value = profile.name;
        $("mypage-input-faculty").value = profile.faculty;
        campusSelect.value = profile.campus;
      }
    }

    function render() {
      var profile = store.profile();
      setPhoto(avatar, profile.photo_url);
      $("mypage-name").textContent = profile.name || "名前未設定";
      $("mypage-faculty").textContent = profile.faculty;
      $("mypage-campus").textContent = profile.campus ? profile.campus + "キャンパス" : "";
      showRating("mypage-rating", cache.me);
      setEditing(false);
      renderBadges();
    }

    return { render: render };
  })();

  /* ------------------------------------------------------------------
     ログアウト
  ------------------------------------------------------------------ */
  // この端末だけログアウトする（ほかの端末のログインは残す）。
  $("mypage-logout").addEventListener("click", async function () {
    await sb.auth.signOut({ scope: "local" });
    if (cache.me) leave();
  });

  /* ------------------------------------------------------------------
     ルーティング
  ------------------------------------------------------------------ */
  var ROUTES = {
    "#/login": { view: "view-login", tabs: false, auth: false },
    "#/signup": { view: "view-signup", tabs: false, auth: false },
    "#/home": { view: "view-home", tabs: true, tab: "#/home", render: function () { home.render(); } },
    "#/search": { view: "view-search", tabs: true, tab: "#/search", render: function () { search.render(); } },
    "#/results": { view: "view-results", tabs: true, tab: "#/search", render: function () { results.render(); } },
    "#/sell": { view: "view-sell", tabs: true, tab: "#/sell", render: function () { sell.render(); } },
    "#/terms": { view: "view-terms", tabs: true, tab: "#/mypage", auth: "any" },
    "#/transactions": { view: "view-transactions", tabs: true, tab: "#/mypage", render: renderTransactions },
    "#/listings": { view: "view-listings", tabs: true, tab: "#/mypage", render: renderListings },
    "#/mypage": { view: "view-mypage", tabs: true, tab: "#/mypage", render: function () { mypage.render(); } }
  };

  function route() {
    var hash = window.location.hash || "#/login";
    var match = /^#\/(item|apply|chat)\/(.+)$/.exec(hash);
    var config;
    var param = null;

    if (match) {
      param = match[2];
      if (match[1] === "item") {
        config = { view: "view-detail", tabs: true, tab: "#/search", render: function () { detail.render(param); } };
      } else if (match[1] === "apply") {
        config = { view: "view-confirm", tabs: true, tab: "#/search", render: function () { confirmView.render(param); } };
      } else {
        config = { view: "view-chat", tabs: true, tab: "#/mypage", render: function () { chat.render(param); } };
      }
    } else {
      config = ROUTES[hash];
    }

    if (!config) {
      go(cache.me ? "#/home" : "#/login");
      return;
    }

    // auth: false はログイン前だけの画面、"any" はどちらでも開ける画面（利用規約）。
    if (config.auth !== false && config.auth !== "any" && !cache.me) {
      go("#/login");
      return;
    }

    if (cache.me && config.auth === false) {
      go("#/home");
      return;
    }

    // 画面を離れたら、メッセージの自動更新を止める。
    chat.stop();

    each(document.querySelectorAll(".view"), function (view) {
      view.hidden = view.id !== config.view;
    });

    var tabbar = $("tabbar");
    tabbar.hidden = !(config.tabs && cache.me);
    each(tabbar.querySelectorAll(".tab"), function (tab) {
      if (config.tab && tab.getAttribute("data-go") === config.tab) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });

    if (config.render) config.render();
    window.scrollTo(0, 0);
  }

  document.addEventListener("click", function (event) {
    var target = event.target.closest ? event.target.closest("[data-go], [data-back]") : null;
    if (!target) return;
    if (target.hasAttribute("data-back")) {
      event.preventDefault();
      if (window.history.length > 1) window.history.back();
      else go("#/home");
      return;
    }
    event.preventDefault();
    go(target.getAttribute("data-go"));
  });

  // 確認メールのリンクから戻ると、URL に #access_token=... や ?code=... が付いている。
  // ルーターが先に動くと未知のハッシュとして #/login へ書き換え、トークンを読めなくなる。
  // そのため supabase-js のセッション取得を待ち、URL を掃除してからルーターを動かす。
  function readAuthCallback() {
    var hash = window.location.hash.slice(1);
    var fromHash = new URLSearchParams(hash.indexOf("=") >= 0 ? hash : "");
    var fromQuery = new URLSearchParams(window.location.search);
    return {
      present: fromHash.has("access_token") || fromHash.has("error") || fromQuery.has("code") || fromQuery.has("error"),
      error: fromHash.get("error_code") || fromHash.get("error") || fromQuery.get("error_code") || fromQuery.get("error")
    };
  }

  async function start() {
    var callback = readAuthCallback();
    var result = await sb.auth.getSession().catch(function () { return { data: { session: null } }; });
    var session = result.data.session;

    if (callback.present) window.history.replaceState(null, "", window.location.pathname);

    if (session) {
      await enter(session);
      if (callback.present) toast("メールアドレスを確認しました");
    } else if (callback.present) {
      showLoginNote(callback.error === "otp_expired"
        ? "確認リンクの有効期限が切れています。もう一度登録してください"
        : "確認リンクからログインできませんでした。メールアドレスとパスワードでログインしてください");
    }

    // ほかのタブでのログアウトやセッション切れ。このコールバック内では Supabase を await しない。
    sb.auth.onAuthStateChange(function (event) {
      if (event === "SIGNED_OUT" && cache.me) leave();
    });

    window.addEventListener("hashchange", route);
    if (callback.present) go(cache.me ? "#/home" : "#/login");
    else route();
  }

  // 以前の版が端末に残したデータ（平文パスワードを含む）を消す。
  ["yum.accounts", "yum.session", "yum.profile", "yum.listings", "yum.applications", "yum.wants", "yum.favorites"].forEach(function (key) {
    try { window.localStorage.removeItem(key); } catch (error) { /* 消せなくても続行する */ }
  });

  start();
})();
