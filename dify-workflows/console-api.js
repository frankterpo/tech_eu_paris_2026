/**
 * Dify Cloud Console API — Working Workaround Scripts
 *
 * Dify Cloud uses HttpOnly session cookies + CSRF token for auth.
 * The CSRF token from `__Host-csrf_token` cookie must be sent
 * as `X-CSRF-Token` header on every Console API request.
 *
 * Usage: paste the desired script in browser console at cloud.dify.ai
 *
 * STATUS (2026-02-18):
 *   - DSL import via yaml-url WORKS but imported agents crash with 500
 *     when processing real inputs (Dify Cloud backend bug)
 *   - Blank agents created via POST /console/api/apps WORK fine
 *   - Next: configure blank agents via PUT /model-config incrementally
 *
 * Known Dify Cloud bugs:
 *   - GET /console/api/apps/{id} → 400 psycopg2.errors.InFailedSqlTransaction
 *     (annotation_reply field corruption on DSL-imported apps)
 *   - Frontend crashes when clicking into DSL-imported apps
 *   - GET /console/api/apps/{id}/model-config → 405 (method not allowed,
 *     must use PUT; GET on list endpoint returns model_config instead)
 */

// ── Helper: CSRF token ─────────────────────────────────────────────
// const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
// const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };

// ════════════════════════════════════════════════════════════════════
// 1. LIST ALL APPS
// ════════════════════════════════════════════════════════════════════
/*
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const res = await fetch('/console/api/apps?page=1&limit=100', { headers });
  const { data: apps } = await res.json();
  console.table(apps.map(a => ({ name: a.name, id: a.id, mode: a.mode })));
})();
*/

// ════════════════════════════════════════════════════════════════════
// 2. CREATE BLANK AGENTS (recommended — avoids DSL import bugs)
//    Creates 3 blank agent-chat apps + generates API keys
// ════════════════════════════════════════════════════════════════════
/*
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };

  const agents = [
    { name: 'analyst_agent_v2', icon: '🔍', desc: 'Analyst Agent v2' },
    { name: 'associate_agent_v2', icon: '🧠', desc: 'Associate Agent v2' },
    { name: 'partner_agent_v2', icon: '🎯', desc: 'Partner Agent v2' },
  ];

  for (const a of agents) {
    const r = await fetch('/console/api/apps', {
      method: 'POST', headers,
      body: JSON.stringify({ name: a.name, mode: 'agent-chat', icon_type: 'emoji', icon: a.icon, icon_background: '#E4FBCC', description: a.desc })
    });
    const app = await r.json();
    const tokR = await fetch(`/console/api/apps/${app.id}/api-keys`, { method: 'POST', headers, body: '{}' });
    const tokD = await tokR.json();
    const key = tokD.token || tokD.data?.[0]?.token;
    console.log(`✅ ${a.name}: id=${app.id} key=${key}`);
  }
})();
*/

// ════════════════════════════════════════════════════════════════════
// 3. IMPORT AGENTS FROM GIST URL (yaml-url mode)
//    ⚠️ Works but imported agents crash with 500 on real inputs
//    Use script #2 (blank agents) + #5 (PUT model-config) instead
// ════════════════════════════════════════════════════════════════════
/*
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };

  const yamls = [
    'https://gist.githubusercontent.com/frankterpo/bcc47816f4c7622d47145765843f709b/raw/analyst_agent_v2.yml',
    'https://gist.githubusercontent.com/frankterpo/bcc47816f4c7622d47145765843f709b/raw/associate_agent_v2.yml',
    'https://gist.githubusercontent.com/frankterpo/bcc47816f4c7622d47145765843f709b/raw/partner_agent_v2.yml',
  ];

  for (const url of yamls) {
    const r = await fetch('/console/api/apps/imports', {
      method: 'POST', headers,
      body: JSON.stringify({ mode: 'yaml-url', yaml_url: url })
    });
    const d = await r.json();
    console.log(`${url.split('/').pop()}: status=${d.status} app_id=${d.app_id} error=${d.error || 'none'}`);
  }
})();
*/

// ════════════════════════════════════════════════════════════════════
// 4. GET API KEYS for all agent-chat v2 apps
// ════════════════════════════════════════════════════════════════════
/*
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const res = await fetch('/console/api/apps?page=1&limit=100', { headers });
  const { data: apps } = await res.json();
  const agents = apps.filter(a => a.mode === 'agent-chat' && a.name.includes('_v2'));
  for (const app of agents) {
    let tokRes = await fetch(`/console/api/apps/${app.id}/api-keys`, { headers });
    let tokData = await tokRes.json();
    let keys = tokData.data || [];
    if (keys.length === 0) {
      tokRes = await fetch(`/console/api/apps/${app.id}/api-keys`, { method: 'POST', headers, body: '{}' });
      tokData = await tokRes.json();
      keys = tokData.data ? [tokData.data] : [tokData];
    }
    console.log(`${app.name}: ${keys[0]?.token || keys[0]?.api_key}`);
  }
})();
*/

// ════════════════════════════════════════════════════════════════════
// 5. CONFIGURE AGENTS via PUT /model-config
//    Use after creating blank agents (#2) to add prompt + model + tools
//    ⚠️ UNTESTED — next step in debugging workflow
// ════════════════════════════════════════════════════════════════════
/*
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };

  // Replace with actual blank agent IDs from script #2
  const appId = 'PASTE_BLANK_AGENT_ID_HERE';

  // Step 1: Minimal config (test first)
  const minimalConfig = {
    pre_prompt: 'You are a test analyst. Just say hello and confirm you work.',
    model: {
      provider: 'openai', name: 'gpt-4o-mini', mode: 'chat',
      completion_params: { temperature: 0.15, max_tokens: 500 }
    },
    agent_mode: { enabled: true, strategy: 'function_call', max_iteration: 5, tools: [] },
    user_input_form: [
      { 'text-input': { label: 'deal_input', variable: 'deal_input', required: true, default: '' } }
    ]
  };

  const r = await fetch(`/console/api/apps/${appId}/model-config`, {
    method: 'PUT', headers,
    body: JSON.stringify(minimalConfig)
  });
  console.log('PUT model-config:', r.status, await r.text());
})();
*/

// ════════════════════════════════════════════════════════════════════
// 6. INSPECT AGENT CONFIG (uses list endpoint — detail endpoint broken)
// ════════════════════════════════════════════════════════════════════
/*
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const res = await fetch('/console/api/apps?page=1&limit=100', { headers });
  const { data: apps } = await res.json();
  const agents = apps.filter(a => a.mode === 'agent-chat' && a.name.includes('_v2'));

  for (const app of agents) {
    const mc = app.model_config || {};
    const model = mc.model;
    const prompt = mc.pre_prompt || '';
    console.log(`📋 ${app.name} (${app.id})`);
    console.log(`   Model: ${model?.name || 'not set'} temp=${model?.completion_params?.temperature ?? '?'}`);
    console.log(`   Prompt length: ${prompt.length} chars`);
    console.log(`   Has DuckDuckGo: ${prompt.includes('DuckDuckGo')}`);
    console.log(`   Has dealbot_tools: ${prompt.includes('dealbot_tools') || prompt.includes('calaSearch')}`);
  }
})();
*/

// ════════════════════════════════════════════════════════════════════
// 7. DELETE APPS by ID
// ════════════════════════════════════════════════════════════════════
/*
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };

  const toDelete = [
    // Paste app IDs to delete here
    'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  ];

  for (const id of toDelete) {
    const r = await fetch(`/console/api/apps/${id}`, { method: 'DELETE', headers });
    console.log(`Delete ${id}: ${r.status}`);
  }
})();
*/

// ════════════════════════════════════════════════════════════════════
// 8. FULL SETUP: cleanup broken agents + configure blank ones
//    Combines delete + create + PUT model-config in one script
//    ⚠️ Template — fill in IDs and prompts before running
// ════════════════════════════════════════════════════════════════════
/*
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };

  // Step 1: Delete broken DSL-imported agents
  const toDelete = [
    // Paste broken agent IDs here
  ];
  for (const id of toDelete) {
    const r = await fetch(`/console/api/apps/${id}`, { method: 'DELETE', headers });
    console.log(`Delete ${id}: ${r.status}`);
  }

  // Step 2: Create blank agents
  const defs = [
    { name: 'analyst_agent_v2', icon: '🔍' },
    { name: 'associate_agent_v2', icon: '🧠' },
    { name: 'partner_agent_v2', icon: '🎯' },
  ];
  const created = [];
  for (const d of defs) {
    const r = await fetch('/console/api/apps', {
      method: 'POST', headers,
      body: JSON.stringify({ name: d.name, mode: 'agent-chat', icon_type: 'emoji', icon: d.icon, icon_background: '#E4FBCC', description: d.name })
    });
    const app = await r.json();
    const tokR = await fetch(`/console/api/apps/${app.id}/api-keys`, { method: 'POST', headers, body: '{}' });
    const tokD = await tokR.json();
    const key = tokD.token || tokD.data?.[0]?.token;
    created.push({ ...d, id: app.id, key });
    console.log(`✅ ${d.name}: id=${app.id} key=${key}`);
  }

  // Step 3: Configure via PUT /model-config (add prompts, model, tools)
  // Built-in tools (DuckDuckGo + Web Scraper)
  const builtinTools = [
    { enabled: true, isDeleted: false, notAuthor: false,
      provider_id: 'duckduckgo', provider_name: 'duckduckgo', provider_type: 'builtin',
      tool_label: 'DuckDuckGo Search', tool_name: 'ddgo_search', tool_parameters: {} },
    { enabled: true, isDeleted: false, notAuthor: false,
      provider_id: 'webscraper', provider_name: 'webscraper', provider_type: 'builtin',
      tool_label: 'Web Scraper', tool_name: 'webscraper',
      tool_parameters: { url: '', user_agent: '' } }
  ];

  for (const agent of created) {
    const cfg = {
      pre_prompt: 'You are a test. Reply with JSON: {"status":"ok"}',
      model: {
        provider: 'openai', name: 'gpt-4o-mini', mode: 'chat',
        completion_params: { temperature: 0.15, max_tokens: 3000, top_p: 0.9, frequency_penalty: 0, presence_penalty: 0 }
      },
      agent_mode: {
        enabled: true, strategy: 'function_call', max_iteration: 15,
        tools: [...builtinTools]
      },
      user_input_form: [
        { 'text-input': { label: 'deal_input', variable: 'deal_input', required: true, default: '' } }
      ]
    };
    const r = await fetch(`/console/api/apps/${agent.id}/model-config`, {
      method: 'PUT', headers,
      body: JSON.stringify(cfg)
    });
    console.log(`Config ${agent.name}: ${r.status}`, r.ok ? '✅' : await r.text());
  }

  console.log('\n📋 Update .env with:');
  for (const a of created) {
    const envKey = a.name.replace('analyst_agent_v2', 'ANALYST_DIFY_KEY')
      .replace('associate_agent_v2', 'ASSOCIATE_DIFY_KEY')
      .replace('partner_agent_v2', 'PARTNER_DIFY_KEY');
    console.log(`${envKey}=${a.key}`);
  }
})();
*/
