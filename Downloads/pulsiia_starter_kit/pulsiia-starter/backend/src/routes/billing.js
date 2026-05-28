// ============================================================
//  Pulsiia — Routes Facturation
//  GET  /api/billing/status          → statut abonnement société
//  GET  /api/billing/invoices        → liste des factures
//  POST /api/billing/invoices/generate → génère facture du mois
//  PUT  /api/billing/invoices/:id/pay  → marque comme payée (admin)
//  GET  /api/billing/admin/all         → toutes les sociétés (superadmin)
//  POST /api/billing/subscribe         → crée abonnement essai
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const billing = require('../services/billingService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Statut de l'abonnement de MA société ─────────────────────
router.get('/status', authenticate, async (req, res) => {
  try {
    const status = await billing.getSubscriptionStatus(req.user.companyId);
    if (!status) {
      return res.json({ hasSubscription: false });
    }
    res.json({ hasSubscription: true, ...status });
  } catch (err) {
    console.error('[billing/status]', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Liste des factures de MA société ─────────────────────────
router.get('/invoices', authenticate, authorize('DRH', 'ADMIN'), async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      where: { companyId: req.user.companyId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(invoices);
  } catch (err) {
    console.error('[billing/invoices]', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Générer la facture du mois ────────────────────────────────
router.post('/invoices/generate', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const invoice = await billing.generateMonthlyInvoice(req.user.companyId);
    res.status(201).json(invoice);
  } catch (err) {
    console.error('[billing/generate]', err);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

// ── Marquer une facture comme payée ──────────────────────────
router.put('/invoices/:id/pay', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const invoice = await billing.markInvoicePaid(req.params.id);
    res.json(invoice);
  } catch (err) {
    console.error('[billing/pay]', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Créer un abonnement (essai gratuit) ──────────────────────
router.post('/subscribe', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    const existing = await prisma.subscription.findUnique({
      where: { companyId: req.user.companyId },
    });
    if (existing) {
      return res.status(409).json({ error: 'Abonnement déjà existant' });
    }
    const subscription = await billing.createSubscription(req.user.companyId);
    res.status(201).json(subscription);
  } catch (err) {
    console.error('[billing/subscribe]', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Vue admin Pulsiia — toutes les sociétés ──────────────────
router.get('/admin/all', authenticate, authorize('ADMIN'), async (req, res) => {
  try {
    // Vérifie que c'est bien un admin Pulsiia (la société s'appelle Pulsiia)
    const company = await prisma.company.findUnique({
      where: { id: req.user.companyId },
    });
    if (!company || company.name !== 'Pulsiia') {
      return res.status(403).json({ error: 'Accès réservé à Pulsiia' });
    }
    const data = await billing.getAllCompanyBilling();
    res.json(data);
  } catch (err) {
    console.error('[billing/admin/all]', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
