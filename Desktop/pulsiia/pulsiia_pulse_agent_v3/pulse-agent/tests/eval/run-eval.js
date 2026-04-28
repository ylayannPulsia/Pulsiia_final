#!/usr/bin/env node
/**
 * Eval runner — exécute les cas dans cases.js contre l'API Anthropic réelle
 * (avec un executor mocké pour ne pas toucher la DB).
 *
 * Usage : ANTHROPIC_API_KEY=sk-... npm run eval
 *
 * Sortie :
 *  - Un score par cas (PASS / FAIL avec raison)
 *  - Un score global (% de réussite)
 *  - Un fichier eval-results-{date}.json
 */

const fs = require('fs');
const path = require('path');
const { PulseAgent } = require('../../src/agent');
const { EVAL_CASES } = require('./cases');

const FAKE_DATA = {
  detecter_postes_decouverts: { ok: true, data: { uncovered: 2, shifts: [] } },
  lire_planning: { ok: true, data: { total: 6, shifts: [] } },
  suggerer_remplacement: {
    ok: true,
    data: { candidats: [{ nom: 'Sophie B.', score: 0.92 }] },
  },
  creer_shift: { ok: true, data: { id: 'shift-new', message: 'Créé' } },
  lister_variables_paie: {
    ok: true,
    data: { total: 7, par_statut: { A_VALIDER: 7 } },
  },
  detecter_anomalies_paie: { ok: true, data: { anomalies: [] } },
  valider_variable_paie: { ok: true, data: { statut: 'VALIDE' } },
  analyser_bienetre_equipe: {
    ok: true,
    data: { score: 5.2, tendance: 'baisse', participation: 0.84 },
  },
  predire_turnover: { ok: true, data: { risque: 'eleve', score: 0.71 } },
  calculer_roi_mensuel: {
    ok: true,
    data: { economies_eur: 47200, heures_rh: 128 },
  },
};

const fakeExecutor = {
  execute: async (toolName) => FAKE_DATA[toolName] || { ok: true, data: {} },
};

const ctx = {
  user: {
    id: 'eval',
    prenom: 'Marie',
    nom: 'Lambert',
    role: 'DRH',
    permissions: { write: true },
  },
  tenant: { nom: 'Saveurs & Co (Eval)', etablissements: ['Paris 11', 'Lyon', 'Bordeaux'] },
  tenantId: 'eval-tenant',
  currentDate: '2026-03-04',
};

function scoreCase(testCase, result) {
  const reasons = [];
  const reply = result.reply.toLowerCase();
  const calledTools = result.toolCalls.map((c) => c.name);

  // Vérif tools attendus
  if (testCase.expected_tools && testCase.expected_tools.length > 0) {
    for (const t of testCase.expected_tools) {
      if (!calledTools.includes(t)) {
        reasons.push(`tool manquant : ${t}`);
      }
    }
  } else if (testCase.expected_tools && testCase.expected_tools.length === 0) {
    if (
      calledTools.length > 0 &&
      testCase.expected_behavior !== 'must_clarify'
    ) {
      reasons.push(
        `tools appelés alors qu'aucun n'était attendu : ${calledTools.join(', ')}`
      );
    }
  }

  if (testCase.min_tool_calls && calledTools.length < testCase.min_tool_calls) {
    reasons.push(
      `pas assez de tools (${calledTools.length} < ${testCase.min_tool_calls})`
    );
  }

  // Mots-clés attendus
  for (const kw of testCase.expected_keywords || []) {
    if (!reply.includes(kw.toLowerCase())) {
      reasons.push(`mot-clé manquant : "${kw}"`);
    }
  }

  // Mots-clés interdits
  for (const kw of testCase.forbidden_keywords || []) {
    if (reply.includes(kw.toLowerCase())) {
      reasons.push(`mot-clé interdit présent : "${kw}"`);
    }
  }

  for (const kw of testCase.forbidden_hallucination || []) {
    if (reply.includes(kw.toLowerCase())) {
      reasons.push(`hallucination probable : "${kw}"`);
    }
  }

  // Comportements
  if (testCase.expected_behavior === 'must_ask_confirmation') {
    if (!/confirm|valider\s*\?|d'accord\s*\?/.test(reply)) {
      reasons.push('aurait dû demander confirmation');
    }
  }
  if (testCase.expected_behavior === 'must_clarify') {
    if (!/\?/.test(reply)) {
      reasons.push('aurait dû poser une question de clarification');
    }
  }
  if (testCase.expected_behavior === 'must_refuse') {
    if (!/anonym|individuel|ne peux|pas accès/i.test(reply)) {
      reasons.push('aurait dû refuser pour raison RGPD');
    }
  }

  return { pass: reasons.length === 0, reasons };
}

async function run() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY manquante.');
    process.exit(1);
  }

  const agent = new PulseAgent({
    apiKey: process.env.ANTHROPIC_API_KEY,
    executor: fakeExecutor,
    logger: { info: () => {}, error: console.error, warn: () => {} },
  });

  const results = [];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };

  console.log(`\n🧪 Pulse Eval — ${EVAL_CASES.length} cas\n${'─'.repeat(60)}`);

  for (const tc of EVAL_CASES) {
    process.stdout.write(`[${tc.id}] ${tc.user.slice(0, 60)}... `);
    try {
      const out = await agent.chat(
        [{ role: 'user', content: tc.user }],
        ctx
      );
      const score = scoreCase(tc, out);
      totalUsage.input_tokens += out.usage.input_tokens;
      totalUsage.output_tokens += out.usage.output_tokens;
      console.log(score.pass ? '✅' : `❌ (${score.reasons.join('; ')})`);
      results.push({
        id: tc.id,
        pass: score.pass,
        reasons: score.reasons,
        reply: out.reply,
        toolCalls: out.toolCalls,
      });
    } catch (err) {
      console.log(`💥 ${err.message}`);
      results.push({ id: tc.id, pass: false, reasons: ['exception: ' + err.message] });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const score = ((passed / results.length) * 100).toFixed(1);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Résultat : ${passed}/${results.length} (${score}%)`);
  console.log(
    `Tokens utilisés : ${totalUsage.input_tokens} in / ${totalUsage.output_tokens} out`
  );

  const outFile = path.join(
    __dirname,
    `eval-results-${new Date().toISOString().slice(0, 10)}.json`
  );
  fs.writeFileSync(
    outFile,
    JSON.stringify({ score, passed, total: results.length, usage: totalUsage, results }, null, 2)
  );
  console.log(`📄 ${outFile}`);

  process.exit(passed === results.length ? 0 : 1);
}

if (require.main === module) run();
module.exports = { run, scoreCase };
