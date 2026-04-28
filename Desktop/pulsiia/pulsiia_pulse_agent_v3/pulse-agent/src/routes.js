/**
 * Pulse — Routes Express
 * À monter dans le monorepo via : app.use('/api/pulse', require('@pulsiia/pulse-agent/routes'))
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { PulseAgent } = require('./agent');
const { ToolExecutor } = require('./tools/executor');

/**
 * Factory de routeur.
 * @param {object} deps — { prisma, services, logger, requireAuth }
 *   - requireAuth : middleware d'auth existant du monorepo (Passport.js)
 *   - services    : { planning, prepaie, bienetre, roi } du monorepo
 */
function createPulseRouter({ prisma, services, logger, requireAuth }) {
  const router = express.Router();

  const agent = new PulseAgent({
    apiKey: process.env.ANTHROPIC_API_KEY,
    executor: new ToolExecutor({ prisma, services, logger }),
    logger,
  });

  // Rate limit : 30 messages / minute / utilisateur
  const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.user?.id || req.ip,
    message: { error: 'Trop de messages. Réessayez dans une minute.' },
  });

  // ─── POST /api/pulse/chat ──────────────────────
  router.post('/chat', requireAuth, chatLimiter, async (req, res) => {
    const { messages, sessionId } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res
        .status(400)
        .json({ error: '`messages` doit être un tableau non vide' });
    }
    if (messages.length > 30) {
      return res
        .status(400)
        .json({ error: 'Historique trop long (max 30 messages)' });
    }

    try {
      const ctx = {
        user: req.user,
        tenant: req.user.tenant,
        tenantId: req.user.tenantId,
        sessionId: sessionId || `${req.user.id}-${Date.now()}`,
      };

      const result = await agent.chat(messages, ctx);

      res.json({
        reply: result.reply,
        sessionId: ctx.sessionId,
        toolCalls: result.toolCalls,
        usage: result.usage,
        turns: result.turns,
      });
    } catch (err) {
      logger.error('[pulse] chat error', {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({
        error: "Pulse est momentanément indisponible. Réessayez dans un instant.",
      });
    }
  });

  // ─── GET /api/pulse/health ─────────────────────
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      model: agent.model,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = { createPulseRouter };
