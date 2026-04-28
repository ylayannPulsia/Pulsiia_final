/**
 * Pulse Agent — Tool Executor
 *
 * Reçoit les tool_use de Claude, exécute la logique métier
 * (Prisma queries, services Pulsiia), et retourne un tool_result.
 *
 * IMPORTANT — Sécurité :
 * - Tout appel passe par `auditLog()` (RGPD Article 30)
 * - Les actions sensibles (creer_shift, valider_variable_paie) vérifient `ctx.user.permissions`
 * - Les données nominatives bien-être ne sont JAMAIS retournées (anonymisation)
 */

const { auditLog } = require('../middleware/audit');
const { buildMemoryHandlers } = require('../memory/tools');
const { isMockTool, executeMockTool } = require('../mcp/mocks');

class ToolExecutor {
  constructor({ prisma, services, logger, memoryStore }) {
    this.prisma = prisma;
    this.services = services; // { planning, prepaie, bienetre, roi } injectés depuis le monorepo
    this.logger = logger;
    this.memoryStore = memoryStore || null;
    this._memoryHandlers = memoryStore ? buildMemoryHandlers(memoryStore) : {};
  }

  /**
   * Point d'entrée unique — dispatche vers la bonne méthode privée.
   * @param {string} toolName
   * @param {object} input
   * @param {object} ctx — { user, tenantId, sessionId }
   * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
   */
  async execute(toolName, input, ctx) {
    const start = Date.now();
    try {
      this._checkPermission(toolName, ctx);

      // Mock MCP tools — routées vers les handlers mock
      if (isMockTool(toolName)) {
        const mockResult = await executeMockTool(toolName, input);
        await auditLog({
          prisma: this.prisma,
          userId: ctx.user.id,
          tenantId: ctx.tenantId,
          action: `pulse.mcp_mock.${toolName}`,
          target: input,
          outcome: 'success',
          duration_ms: Date.now() - start,
        });
        return { ok: true, data: mockResult };
      }

      const handler = this._handlers[toolName];
      if (!handler) {
        return { ok: false, error: `Tool inconnu : ${toolName}` };
      }

      const result = await handler.call(this, input, ctx);

      await auditLog({
        prisma: this.prisma,
        userId: ctx.user.id,
        tenantId: ctx.tenantId,
        action: `pulse.${toolName}`,
        target: input,
        outcome: 'success',
        duration_ms: Date.now() - start,
      });

      return { ok: true, data: result };
    } catch (err) {
      this.logger.error(`Tool ${toolName} failed`, {
        error: err.message,
        input,
        userId: ctx.user?.id,
      });
      await auditLog({
        prisma: this.prisma,
        userId: ctx.user?.id,
        tenantId: ctx.tenantId,
        action: `pulse.${toolName}`,
        target: input,
        outcome: 'error',
        error: err.message,
        duration_ms: Date.now() - start,
      });
      return { ok: false, error: err.message };
    }
  }

  // ─────────────────────────────────────────────
  // PERMISSIONS
  // ─────────────────────────────────────────────
  _checkPermission(toolName, ctx) {
    const SENSITIVE = new Set([
      'creer_shift',
      'valider_variable_paie',
      // MCP sensitive actions — requièrent permissions.write
      'slack_post_message',
      'slack_send_dm',
      'slack_create_channel',
      'outlook_create_event',
      'outlook_send_email',
      'silae_export_variables',
    ]);
    const ROLE_REQUIREMENTS = {
      valider_variable_paie: ['DRH', 'RH', 'COMPTABLE'],
      creer_shift: ['DRH', 'RH', 'MANAGER'],
      predire_turnover: ['DRH', 'RH'],
      // MCP role requirements
      silae_export_variables: ['DRH', 'RH', 'COMPTABLE'],
      silae_get_bulletins: ['DRH', 'RH', 'COMPTABLE'],
      silae_get_employee_summary: ['DRH', 'RH', 'COMPTABLE'],
      slack_post_message: ['DRH', 'RH', 'MANAGER'],
      slack_send_dm: ['DRH', 'RH', 'MANAGER'],
      slack_create_channel: ['DRH', 'RH'],
      outlook_create_event: ['DRH', 'RH', 'MANAGER'],
      outlook_send_email: ['DRH', 'RH', 'MANAGER'],
    };

    if (!ctx?.user) throw new Error('Authentification requise');

    const required = ROLE_REQUIREMENTS[toolName];
    if (required && !required.includes(ctx.user.role)) {
      throw new Error(
        `Permission refusée : rôle ${ctx.user.role} non autorisé pour ${toolName}`
      );
    }

    if (SENSITIVE.has(toolName) && !ctx.user.permissions?.write) {
      throw new Error('Action en écriture non autorisée pour cet utilisateur');
    }
  }

  // ─────────────────────────────────────────────
  // HANDLERS — implémentation des tools
  // ─────────────────────────────────────────────
  get _handlers() {
    const base = {
      lire_planning: this._lirePlanning,
      detecter_postes_decouverts: this._detecterPostesDecouverts,
      suggerer_remplacement: this._suggererRemplacement,
      creer_shift: this._creerShift,
      lister_variables_paie: this._listerVariablesPaie,
      valider_variable_paie: this._validerVariablePaie,
      detecter_anomalies_paie: this._detecterAnomaliesPaie,
      analyser_bienetre_equipe: this._analyserBienetreEquipe,
      predire_turnover: this._predireTurnover,
      calculer_roi_mensuel: this._calculerRoiMensuel,
    };
    // Memory tools : appellent le store directement, sans le `this.` binding métier
    const memoryWrapped = {};
    for (const [name, fn] of Object.entries(this._memoryHandlers)) {
      memoryWrapped[name] = (input, ctx) => fn(input, ctx);
    }
    return { ...base, ...memoryWrapped };
  }

  // ─── PLANNING ──────────────────────────────────
  async _lirePlanning(input, ctx) {
    const { date_debut, date_fin, etablissement_id, collaborateur_id } = input;
    const where = {
      tenantId: ctx.tenantId,
      date: { gte: new Date(date_debut), lte: new Date(date_fin) },
      ...(etablissement_id && { etablissementId: etablissement_id }),
      ...(collaborateur_id && { collaborateurId: collaborateur_id }),
    };
    const shifts = await this.prisma.shift.findMany({
      where,
      include: { collaborateur: { select: { id: true, nom: true, prenom: true } } },
      orderBy: { date: 'asc' },
      take: 200, // garde-fou volume
    });
    return {
      total: shifts.length,
      periode: { debut: date_debut, fin: date_fin },
      shifts: shifts.map((s) => ({
        id: s.id,
        date: s.date.toISOString().slice(0, 10),
        collaborateur: `${s.collaborateur.prenom} ${s.collaborateur.nom[0]}.`,
        horaires: `${s.heureDebut}-${s.heureFin}`,
        type: s.typeShift,
        statut: s.statut,
      })),
    };
  }

  async _detecterPostesDecouverts(input, ctx) {
    return this.services.planning.detectUncoveredShifts({
      tenantId: ctx.tenantId,
      from: input.date_debut,
      to: input.date_fin,
      etablissementId: input.etablissement_id,
    });
  }

  async _suggererRemplacement(input, ctx) {
    return this.services.planning.suggestReplacement({
      tenantId: ctx.tenantId,
      shiftId: input.shift_id,
      maxSuggestions: input.max_suggestions || 3,
    });
  }

  async _creerShift(input, ctx) {
    const created = await this.prisma.shift.create({
      data: {
        tenantId: ctx.tenantId,
        collaborateurId: input.collaborateur_id,
        etablissementId: input.etablissement_id,
        date: new Date(input.date),
        heureDebut: input.heure_debut,
        heureFin: input.heure_fin,
        typeShift: input.type_shift,
        statut: 'PLANIFIE',
        createdBy: ctx.user.id,
      },
    });
    return { id: created.id, message: 'Shift créé avec succès' };
  }

  // ─── PRÉ-PAIE ──────────────────────────────────
  async _listerVariablesPaie(input, ctx) {
    const { periode, statut = 'tous', etablissement_id } = input;
    const [year, month] = periode.split('-').map(Number);
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59);

    const where = {
      tenantId: ctx.tenantId,
      periode: { gte: start, lte: end },
      ...(statut !== 'tous' && { statut: statut.toUpperCase() }),
      ...(etablissement_id && { etablissementId: etablissement_id }),
    };

    const variables = await this.prisma.variablePaie.findMany({
      where,
      include: { collaborateur: { select: { nom: true, prenom: true } } },
      take: 500,
    });

    return {
      periode,
      total: variables.length,
      par_statut: variables.reduce((acc, v) => {
        acc[v.statut] = (acc[v.statut] || 0) + 1;
        return acc;
      }, {}),
      variables: variables.map((v) => ({
        id: v.id,
        collaborateur: `${v.collaborateur.prenom} ${v.collaborateur.nom[0]}.`,
        type: v.type,
        valeur: v.valeur,
        unite: v.unite,
        source: v.source,
        statut: v.statut,
      })),
    };
  }

  async _validerVariablePaie(input, ctx) {
    const { variable_id, commentaire } = input;
    const updated = await this.prisma.variablePaie.update({
      where: { id: variable_id, tenantId: ctx.tenantId },
      data: {
        statut: 'VALIDE',
        validatedAt: new Date(),
        validatedBy: ctx.user.id,
        commentaireValidation: commentaire,
      },
    });
    return {
      id: updated.id,
      statut: updated.statut,
      message: `Variable validée par ${ctx.user.email}`,
    };
  }

  async _detecterAnomaliesPaie(input, ctx) {
    return this.services.prepaie.detectAnomalies({
      tenantId: ctx.tenantId,
      periode: input.periode,
    });
  }

  // ─── BIEN-ÊTRE ─────────────────────────────────
  async _analyserBienetreEquipe(input, ctx) {
    // Toujours anonymisé — pas d'IDs nominatifs retournés
    return this.services.bienetre.analyzeTeam({
      tenantId: ctx.tenantId,
      equipeId: input.equipe_id,
      etablissementId: input.etablissement_id,
      windowDays: input.periode_jours || 30,
      anonymize: true,
    });
  }

  async _predireTurnover(input, ctx) {
    return this.services.bienetre.predictTurnover({
      tenantId: ctx.tenantId,
      equipeId: input.equipe_id,
      collaborateurId: input.collaborateur_id,
    });
  }

  // ─── ROI ───────────────────────────────────────
  async _calculerRoiMensuel(input, ctx) {
    const periode =
      input.periode || new Date().toISOString().slice(0, 7); // YYYY-MM
    return this.services.roi.computeMonthly({
      tenantId: ctx.tenantId,
      periode,
    });
  }
}

module.exports = { ToolExecutor };
