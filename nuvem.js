/* =====================================================================
   Nuvem (Supabase): login por e-mail e senha + dados salvos online.
   Os apps continuam guardando tudo no localStorage; este arquivo:
   1) pede login antes de mostrar qualquer coisa;
   2) baixa os dados da nuvem para o navegador ao abrir;
   3) envia para a nuvem cada alteração salva.
   As regras de quem vê o quê ficam no banco (RLS), não aqui.
   ===================================================================== */
(function(){
  'use strict';
  var URL_SB = 'https://xhnsrbmqgibpcwblaijy.supabase.co';
  var CHAVE = 'sb_publishable_NomC0jWE6QJiNsZk2D8lKg_Tl5YX0VI';

  var S = Storage.prototype;
  var RAW_GET = S.getItem, RAW_SET = S.setItem, RAW_DEL = S.removeItem, RAW_KEY = S.key;
  var LS = window.localStorage;
  var rget = function(k){ try{ return RAW_GET.call(LS, k); }catch(e){ return null; } };
  var rset = function(k,v){ try{ RAW_SET.call(LS, k, v); }catch(e){} };
  var rdel = function(k){ try{ RAW_DEL.call(LS, k); }catch(e){} };

  // só estas chaves vão para a nuvem
  var SINC = /^(cli_[^:]+::)?(central-clientes-v\d+|demo-pagamentos-eventos-v\d+)$/;
  function dadosId(chave){
    if (/^central-clientes/.test(chave)) return '_central';
    var m = chave.match(/^cli_([^:]+)::/); return m ? m[1] : '_padrao';
  }

  /* ---------- app aberto dentro da Central: só repassa as alterações ---------- */
  var pai = null;
  try{ if (window.parent !== window && window.parent.__nuvem) pai = window.parent.__nuvem; }catch(e){}
  if (pai){
    var ps = S.setItem, pr = S.removeItem;
    S.setItem = function(k, v){ var r = ps.apply(this, arguments); if (this === LS) pai.mudou((window.__P||'') + k, v); return r; };
    S.removeItem = function(k){ var r = pr.apply(this, arguments); if (this === LS) pai.mudou((window.__P||'') + k, null); return r; };
    window.NUVEM = pai.info();
    return;
  }

  var script = document.currentScript;
  var PAGINA = (script && script.dataset.pagina) || 'app';
  var params = new URLSearchParams(location.search);
  var CLI = PAGINA === 'app' ? (params.get('c') || '') : '';

  /* ---------- sessão ---------- */
  var KS = 'nuvem_sessao';
  var sessao = null;
  try{ sessao = JSON.parse(rget(KS) || 'null'); }catch(e){}
  function guardarSessao(s){ sessao = s; if (s) rset(KS, JSON.stringify(s)); else rdel(KS); }
  function deResposta(j){ return {access_token:j.access_token, refresh_token:j.refresh_token, expires_at: Math.floor(Date.now()/1000) + (j.expires_in||3600), email: String((j.user&&j.user.email)||'').toLowerCase()}; }
  // links do e-mail (confirmação de cadastro, troca de senha) voltam com o token no endereço
  var recuperacao = false;
  if (/access_token=/.test(location.hash)){
    var h = new URLSearchParams(location.hash.slice(1));
    var s0 = {access_token:h.get('access_token'), refresh_token:h.get('refresh_token'), expires_at: Math.floor(Date.now()/1000) + (+h.get('expires_in')||3600), email:''};
    try{ s0.email = String(JSON.parse(atob(s0.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).email||'').toLowerCase(); }catch(e){}
    guardarSessao(s0);
    recuperacao = h.get('type') === 'recovery';
    try{ history.replaceState(null, '', location.pathname + location.search); }catch(e){}
  }

  function req(metodo, caminho, corpo, extra){
    var hd = {'apikey': CHAVE, 'Content-Type': 'application/json'};
    if (sessao && sessao.access_token) hd['Authorization'] = 'Bearer ' + sessao.access_token;
    for (var k in (extra||{})) hd[k] = extra[k];
    return fetch(URL_SB + caminho, {method: metodo, headers: hd, body: corpo == null ? undefined : JSON.stringify(corpo)})
      .then(function(r){ return r.text().then(function(t){ var j = null; try{ j = t ? JSON.parse(t) : null; }catch(e){}
        if (!r.ok){ var err = new Error((j && (j.msg || j.message || j.error_description || j.error)) || ('Erro ' + r.status)); err.status = r.status; throw err; }
        return j; }); });
  }
  var renovando = null;
  function garantirToken(){
    if (!sessao) return Promise.reject(new Error('sem sessão'));
    if (sessao.expires_at - 60 > Date.now()/1000) return Promise.resolve();
    if (!renovando) renovando = req('POST', '/auth/v1/token?grant_type=refresh_token', {refresh_token: sessao.refresh_token})
      .then(function(j){ guardarSessao(deResposta(j)); }, function(e){ guardarSessao(null); throw e; })
      .finally(function(){ renovando = null; });
    return renovando;
  }
  function api(metodo, caminho, corpo, extra){ return garantirToken().then(function(){ return req(metodo, caminho, corpo, extra); }); }

  /* ---------- envio das alterações ---------- */
  var gestora = false, pendentes = {}, timers = {}, enviando = 0, erroEnvio = false, pronto = false;
  function mudou(chave, valor){
    if (!pronto || !sessao || !SINC.test(chave)) return;
    pendentes[chave] = true;
    clearTimeout(timers[chave]);
    timers[chave] = setTimeout(function(){ enviar(chave); }, 700);
    estado();
  }
  function enviar(chave){
    delete pendentes[chave]; enviando++; estado();
    var v = rget(chave);
    var p = v == null
      ? api('DELETE', '/rest/v1/armazenamento?chave=eq.' + encodeURIComponent(chave), null, {'Prefer':'return=minimal'})
      : api('POST', '/rest/v1/armazenamento?on_conflict=chave', [{chave: chave, dados_id: dadosId(chave), valor: v, atualizado_em: new Date().toISOString(), atualizado_por: sessao.email}], {'Prefer':'resolution=merge-duplicates,return=minimal'});
    return p.then(function(){ erroEnvio = false; if (gestora && /^central-clientes/.test(chave) && v) return sincronizarAcessos(v); },
                  function(e){ erroEnvio = true; console.warn('[nuvem] não salvou', chave, e); })
      .finally(function(){ enviando--; estado(); });
  }
  S.setItem = function(k, v){ var r = RAW_SET.apply(this, arguments); if (this === LS) mudou(String(k), v); return r; };
  S.removeItem = function(k){ var r = RAW_DEL.apply(this, arguments); if (this === LS) mudou(String(k), null); return r; };
  window.addEventListener('beforeunload', function(e){ if (Object.keys(pendentes).length || enviando){ Object.keys(pendentes).forEach(enviar); e.preventDefault(); e.returnValue = ''; } });

  // A Central decide quem acessa cada cliente; isso vira a tabela "acessos" no banco
  function sincronizarAcessos(json){
    var db; try{ db = JSON.parse(json); }catch(e){ return; }
    var linhas = [];
    (db.pessoas||[]).forEach(function(p){
      var email = String(p.email||'').trim().toLowerCase();
      if (!email || p.status !== 'ativo') return;
      Object.keys(p.acessos||{}).forEach(function(cid){
        var c = (db.clientes||[]).find(function(x){ return x.id === cid; });
        if (!c || c.status !== 'ativo') return;
        linhas.push({email: email, cliente_id: cid, dados_id: c.dadosProprios ? cid : '_padrao', prefixo: c.dadosProprios ? 'cli_' + cid + '::' : '', perfil: (p.acessos[cid]||{}).perfil || 'leitura', cliente_nome: c.nome || ''});
      });
    });
    var assin = JSON.stringify(linhas);
    if (assin === sincronizarAcessos.ultima) return;
    return api('DELETE', '/rest/v1/acessos?email=neq.__nenhum__', null, {'Prefer':'return=minimal'})
      .then(function(){ return linhas.length ? api('POST', '/rest/v1/acessos', linhas, {'Prefer':'return=minimal'}) : null; })
      .then(function(){ sincronizarAcessos.ultima = assin; }, function(e){ erroEnvio = true; console.warn('[nuvem] acessos', e); estado(); });
  }

  /* ---------- prefixo do cliente (app aberto direto pelo cliente) ---------- */
  var KP = CLI ? 'nuvem_prefixo_' + CLI : '';
  var PREF = CLI ? (rget(KP) || '') : '';
  if (PREF){
    var g = S.getItem, st = S.setItem, rm = S.removeItem;
    S.getItem = function(x){ return g.call(this, (this === LS && !/^nuvem_/.test(x) ? PREF : '') + x); };
    S.setItem = function(x, v){ return st.call(this, (this === LS && !/^nuvem_/.test(x) ? PREF : '') + x, v); };
    S.removeItem = function(x){ return rm.call(this, (this === LS && !/^nuvem_/.test(x) ? PREF : '') + x); };
  }

  /* ---------- tela de login / carregando ---------- */
  var css = document.createElement('style');
  css.textContent = 'html.nuvem-off body>*:not(#nuvemTela){visibility:hidden!important}'
   + '#nuvemTela{position:fixed;inset:0;z-index:2147483000;background:#f4efeb;display:flex;align-items:center;justify-content:center;padding:16px;font-family:Poppins,system-ui,sans-serif;color:#002620}'
   + '#nuvemTela .cx{background:#fff;border:1px solid #c37f3640;border-radius:16px;padding:26px 24px;width:100%;max-width:380px;box-shadow:0 10px 30px #0026201a}'
   + '#nuvemTela h1{font-family:"Cormorant Garamond",Georgia,serif;font-weight:600;font-size:28px;margin:0 0 2px}'
   + '#nuvemTela p{margin:0 0 14px;font-size:13px;color:#002620b3}'
   + '#nuvemTela label{display:block;font-size:12px;color:#002620b3;margin:10px 0 4px}'
   + '#nuvemTela input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #c37f3666;border-radius:10px;font:inherit;font-size:14px;background:#fff;color:#002620}'
   + '#nuvemTela input:focus{outline:2px solid #efbb3c;border-color:#efbb3c}'
   + '#nuvemTela button.pri{width:100%;margin-top:16px;padding:11px;border:0;border-radius:10px;background:#002620;color:#f4efeb;font:inherit;font-weight:600;cursor:pointer}'
   + '#nuvemTela button.pri:disabled{opacity:.6;cursor:wait}'
   + '#nuvemTela .lk{display:flex;justify-content:space-between;gap:8px;margin-top:12px;font-size:12px}'
   + '#nuvemTela .lk a{color:#c37f36;cursor:pointer;text-decoration:underline}'
   + '#nuvemTela .msg{margin-top:12px;font-size:13px;border-radius:8px;padding:8px 10px;display:none}'
   + '#nuvemTela .msg.err{display:block;background:#ef444414;color:#ef4444;border:1px solid #ef444433}'
   + '#nuvemTela .msg.ok{display:block;background:#00262012;color:#002620;border:1px solid #00262033}'
   + '#nuvemTela .marca{width:56px;height:48px;margin-bottom:8px;border-radius:12px;background:#002620 url(data:image/png;base64,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) center/36px auto no-repeat}'
   + '#nuvemTela .lista button{display:block;width:100%;text-align:left;margin-top:8px;padding:12px;border:1px solid #c37f3666;border-radius:10px;background:#fff;font:inherit;cursor:pointer;color:#002620}'
   + '#nuvemTela .lista button:hover{border-color:#002620}'
   + '#nuvemTela .spin{width:28px;height:28px;border:3px solid #efbb3c55;border-top-color:#002620;border-radius:50%;animation:nvg 0.8s linear infinite;margin:0 auto}'
   + '@keyframes nvg{to{transform:rotate(360deg)}}'
   + '#nuvemChip{position:fixed;left:10px;bottom:10px;z-index:2147482000;background:#002620;color:#f4efeb;font:500 11px Poppins,system-ui,sans-serif;border-radius:99px;padding:5px 6px 5px 11px;display:flex;align-items:center;gap:8px;box-shadow:0 4px 14px #00262033;max-width:calc(100vw - 20px)}'
   + '#nuvemChip .em{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;opacity:.85}'
   + '#nuvemChip button{background:#f4efeb22;border:1px solid #f4efeb55;color:#f4efeb;border-radius:99px;font:inherit;padding:2px 9px;cursor:pointer}'
   + '#nuvemChip .st.err{color:#efbb3c;font-weight:700}'
   + '@media print{#nuvemChip{display:none}}';
  document.head.appendChild(css);
  document.documentElement.classList.add('nuvem-off');

  var tela = null;
  function noBody(fn){ if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  function mostrar(html){
    noBody(function(){
      if (!tela){ tela = document.createElement('div'); tela.id = 'nuvemTela'; document.body.appendChild(tela); }
      tela.innerHTML = '<div class="cx">' + html + '</div>';
      var i = tela.querySelector('input'); if (i) i.focus();
    });
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function carregando(txt){ mostrar('<div class="spin"></div><p style="text-align:center;margin:14px 0 0">' + esc(txt || 'Carregando seus dados…') + '</p>'); }
  function liberar(){
    pronto = true;
    document.documentElement.classList.remove('nuvem-off');
    if (tela){ tela.remove(); tela = null; }
    noBody(function(){ chip(); try{ if (typeof window.render === 'function') window.render(); }catch(e){} });
  }
  function msg(tipo, t){ var m = tela && tela.querySelector('.msg'); if (m){ m.className = 'msg ' + tipo; m.textContent = t; } }
  function traduz(e){
    var t = String(e && e.message || e);
    if (/invalid login|invalid_credentials/i.test(t)) return 'E-mail ou senha incorretos.';
    if (/email not confirmed/i.test(t)) return 'Confirme seu e-mail antes de entrar: abra o link que enviamos para você.';
    if (/already registered|already exists/i.test(t)) return 'Este e-mail já tem cadastro. Use "Entrar" ou "Esqueci a senha".';
    if (/password should be at least|weak/i.test(t)) return 'A senha precisa ter pelo menos 6 caracteres.';
    if (/rate limit|too many/i.test(t)) return 'Muitas tentativas. Espere alguns minutos e tente de novo.';
    if (/failed to fetch|network/i.test(t)) return 'Sem conexão com a internet. Verifique e tente de novo.';
    return t;
  }
  var TOPO = '<div class="marca"></div><h1>Renata Campos</h1>';
  function telaEntrar(aviso){
    mostrar(TOPO + '<p>Inteligência Financeira · entre com seu e-mail e senha</p>'
      + '<form id="nvF"><label>E-mail</label><input id="nvE" type="email" autocomplete="username" required>'
      + '<label>Senha</label><input id="nvS" type="password" autocomplete="current-password" required>'
      + '<button class="pri" id="nvB">Entrar</button></form>'
      + '<div class="lk"><a id="nvCad">Primeiro acesso? Criar senha</a><a id="nvEsq">Esqueci a senha</a></div><div class="msg"></div>');
    noBody(function(){
      if (aviso) msg(aviso[0], aviso[1]);
      tela.querySelector('#nvF').onsubmit = function(ev){ ev.preventDefault();
        var b = tela.querySelector('#nvB'); b.disabled = true; b.textContent = 'Entrando…';
        req('POST', '/auth/v1/token?grant_type=password', {email: tela.querySelector('#nvE').value.trim(), password: tela.querySelector('#nvS').value})
          .then(function(j){ guardarSessao(deResposta(j)); iniciar(); }, function(e){ b.disabled = false; b.textContent = 'Entrar'; msg('err', traduz(e)); });
      };
      tela.querySelector('#nvCad').onclick = telaCadastro;
      tela.querySelector('#nvEsq').onclick = telaEsqueci;
    });
  }
  function telaCadastro(){
    mostrar(TOPO + '<p>Primeiro acesso: use o e-mail que a gestora liberou e crie sua senha.</p>'
      + '<form id="nvF"><label>E-mail</label><input id="nvE" type="email" autocomplete="username" required>'
      + '<label>Crie uma senha (mínimo 6 caracteres)</label><input id="nvS" type="password" autocomplete="new-password" minlength="6" required>'
      + '<button class="pri" id="nvB">Criar senha</button></form>'
      + '<div class="lk"><a id="nvVolta">← Voltar para entrar</a></div><div class="msg"></div>');
    noBody(function(){
      tela.querySelector('#nvVolta').onclick = function(){ telaEntrar(); };
      tela.querySelector('#nvF').onsubmit = function(ev){ ev.preventDefault();
        var b = tela.querySelector('#nvB'); b.disabled = true;
        var base = location.origin + location.pathname.replace(/[^\/]*$/, '');
        req('POST', '/auth/v1/signup?redirect_to=' + encodeURIComponent(base), {email: tela.querySelector('#nvE').value.trim(), password: tela.querySelector('#nvS').value})
          .then(function(j){
            if (j && j.access_token){ guardarSessao(deResposta(j)); iniciar(); return; }
            telaEntrar(['ok', 'Pronto! Enviamos um e-mail de confirmação. Abra o link e depois entre com seu e-mail e senha.']);
          }, function(e){ b.disabled = false; msg('err', traduz(e)); });
      };
    });
  }
  function telaEsqueci(){
    mostrar(TOPO + '<p>Digite seu e-mail. Vamos enviar um link para você criar uma senha nova.</p>'
      + '<form id="nvF"><label>E-mail</label><input id="nvE" type="email" autocomplete="username" required>'
      + '<button class="pri" id="nvB">Enviar link</button></form>'
      + '<div class="lk"><a id="nvVolta">← Voltar para entrar</a></div><div class="msg"></div>');
    noBody(function(){
      tela.querySelector('#nvVolta').onclick = function(){ telaEntrar(); };
      tela.querySelector('#nvF').onsubmit = function(ev){ ev.preventDefault();
        var b = tela.querySelector('#nvB'); b.disabled = true;
        var base = location.origin + location.pathname.replace(/[^\/]*$/, '');
        req('POST', '/auth/v1/recover?redirect_to=' + encodeURIComponent(base), {email: tela.querySelector('#nvE').value.trim()})
          .then(function(){ telaEntrar(['ok', 'Se o e-mail tiver cadastro, você vai receber o link em alguns minutos. Confira também o spam.']); },
                function(e){ b.disabled = false; msg('err', traduz(e)); });
      };
    });
  }
  function telaNovaSenha(){
    mostrar(TOPO + '<p>Crie sua senha nova.</p>'
      + '<form id="nvF"><label>Nova senha (mínimo 6 caracteres)</label><input id="nvS" type="password" autocomplete="new-password" minlength="6" required>'
      + '<button class="pri" id="nvB">Salvar senha</button></form><div class="msg"></div>');
    noBody(function(){
      tela.querySelector('#nvF').onsubmit = function(ev){ ev.preventDefault();
        var b = tela.querySelector('#nvB'); b.disabled = true;
        api('PUT', '/auth/v1/user', {password: tela.querySelector('#nvS').value})
          .then(function(){ recuperacao = false; iniciar(); }, function(e){ b.disabled = false; msg('err', traduz(e)); });
      };
    });
  }

  /* ---------- sair ---------- */
  function sair(){
    var fim = function(){
      guardarSessao(null);
      // não deixa os dados no computador depois de sair
      var ks = []; for (var i = 0; i < LS.length; i++){ var k = RAW_KEY.call(LS, i); if (k && (SINC.test(k) || /^nuvem_prefixo_/.test(k))) ks.push(k); }
      ks.forEach(rdel);
      location.replace(location.pathname.replace(/[^\/]*$/, '') + 'index.html');
    };
    var pend = Object.keys(pendentes);
    Promise.all(pend.map(enviar)).then(function(){ return req('POST', '/auth/v1/logout', {}); }).then(fim, fim);
  }
  function chip(){
    if (document.getElementById('nuvemChip') || !sessao) return;
    var c = document.createElement('div'); c.id = 'nuvemChip';
    c.innerHTML = '<span class="st">☁</span><span class="em"></span><button type="button">Sair</button>';
    c.querySelector('.em').textContent = sessao.email;
    c.querySelector('button').onclick = sair;
    document.body.appendChild(c); estado();
  }
  function estado(){
    var c = document.getElementById('nuvemChip'); if (!c) return;
    var st = c.querySelector('.st');
    if (erroEnvio){ st.textContent = '⚠ não salvou'; st.className = 'st err'; st.title = 'Verifique a internet. As alterações ficam guardadas neste navegador e vão para a nuvem na próxima alteração.'; }
    else if (enviando || Object.keys(pendentes).length){ st.textContent = '☁ salvando…'; st.className = 'st'; st.title = ''; }
    else { st.textContent = '☁ salvo'; st.className = 'st'; st.title = 'Tudo salvo na nuvem'; }
  }

  /* ---------- começo ---------- */
  function linkApp(a){ return 'demo-fluxo-caixa.html?c=' + encodeURIComponent(a.cliente_id); }
  function telaSemAcesso(){
    mostrar(TOPO + '<p>Você entrou como <b>' + esc(sessao.email) + '</b>, mas este e-mail ainda não tem acesso a nenhum app.</p><p>Peça para a gestora liberar o seu e-mail em "Controle de acessos".</p><button class="pri" id="nvSair">Sair</button>');
    noBody(function(){ tela.querySelector('#nvSair').onclick = sair; });
  }
  function escolherApp(lista){
    mostrar(TOPO + '<p>Escolha qual app quer abrir:</p><div class="lista">' + lista.map(function(a, i){ return '<button data-i="' + i + '"><b>' + esc(a.cliente_nome || 'App') + '</b></button>'; }).join('') + '</div><div class="lk"><a id="nvSair">Sair</a></div>');
    noBody(function(){
      tela.querySelectorAll('.lista button').forEach(function(b){ b.onclick = function(){ location.href = linkApp(lista[+b.dataset.i]); }; });
      tela.querySelector('#nvSair').onclick = sair;
    });
  }
  function baixar(filtro){
    return api('GET', '/rest/v1/armazenamento?select=chave,dados_id,valor' + (filtro || ''));
  }
  // aplica o que veio da nuvem no navegador; se mudou algo, recarrega a página uma vez para o app ler os dados novos
  function aplicar(linhas, podeSubir, filtroLocal){
    var mudouAlgo = false, naNuvem = {};
    (linhas||[]).forEach(function(l){ naNuvem[l.chave] = 1; if (rget(l.chave) !== l.valor){ rset(l.chave, l.valor); mudouAlgo = true; } });
    var subir = [];
    if (podeSubir){
      for (var i = 0; i < LS.length; i++){ var k = RAW_KEY.call(LS, i); if (k && SINC.test(k) && !naNuvem[k] && (!filtroLocal || filtroLocal(k))) subir.push(k); }
    }
    var n = +(sessionStorage.getItem('nuvem_recarga') || 0);
    if (mudouAlgo && n < 2){ sessionStorage.setItem('nuvem_recarga', n + 1); location.reload(); return true; }
    sessionStorage.removeItem('nuvem_recarga');
    liberar();
    subir.forEach(function(k){ pendentes[k] = true; setTimeout(function(){ enviar(k); }, 300); });
    return false;
  }
  function iniciar(){
    if (!sessao){ telaEntrar(); return; }
    if (recuperacao){ telaNovaSenha(); return; }
    carregando();
    api('GET', '/rest/v1/gestoras?select=email').then(function(g){
      gestora = !!(g && g.length);
      window.NUVEM = {email: sessao.email, gestora: gestora, cliente: CLI};
      if (gestora){
        if (CLI){   // gestora abrindo o app de um cliente pelo link do cliente
          return api('GET', '/rest/v1/acessos?select=*&cliente_id=eq.' + encodeURIComponent(CLI) + '&limit=1').then(function(a){
            var pf = a && a[0] ? a[0].prefixo : 'cli_' + CLI + '::';
            if (pf !== PREF){ rset(KP, pf); location.reload(); return; }
            return baixar().then(function(l){ aplicar(l, true); });
          });
        }
        return baixar().then(function(l){ aplicar(l, true); });
      }
      // cliente: só vê os apps liberados para o e-mail dele
      return api('GET', '/rest/v1/acessos?select=*&email=eq.' + encodeURIComponent(sessao.email)).then(function(lista){
        lista = lista || [];
        if (!lista.length){ telaSemAcesso(); return; }
        var a = CLI ? lista.find(function(x){ return x.cliente_id === CLI; }) : null;
        if (!a){ if (lista.length === 1) location.replace(linkApp(lista[0])); else escolherApp(lista); return; }
        if ((a.prefixo || '') !== PREF){ rset(KP, a.prefixo || ''); location.reload(); return; }
        window.NUVEM.perfil = a.perfil; window.NUVEM.clienteNome = a.cliente_nome;
        return baixar('&dados_id=eq.' + encodeURIComponent(a.dados_id)).then(function(l){ aplicar(l, false); });
      });
    }).catch(function(e){
      if (!sessao || e.status === 401){ guardarSessao(null); telaEntrar(['err', 'Sua sessão expirou. Entre de novo.']); return; }
      mostrar(TOPO + '<p>Não consegui falar com a nuvem.</p><div class="msg err" style="display:block">' + esc(traduz(e)) + '</div><button class="pri" id="nvTenta">Tentar de novo</button><div class="lk"><a id="nvSair">Sair</a></div>');
      noBody(function(){ tela.querySelector('#nvTenta').onclick = iniciar; tela.querySelector('#nvSair').onclick = sair; });
    });
  }

  // o app aberto dentro da Central usa estas funções para salvar
  window.__nuvem = {
    mudou: mudou,
    info: function(){ return window.NUVEM || null; }
  };
  window.NUVEM = null;
  iniciar();
})();
