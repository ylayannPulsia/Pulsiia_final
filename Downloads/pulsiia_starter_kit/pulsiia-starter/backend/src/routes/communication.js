// src/routes/communication.js — Canaux, messages internes & boîte à idées
const router = require('express').Router();
const { body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { prisma, getCompanyId, withCompany } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { upload } = require('../lib/uploads');
const crypto = require('crypto');

/* ═══════════════════════════════════════════════════════════════
   MODÉRATION — liste de mots interdits (harcèlement / insultes)
═══════════════════════════════════════════════════════════════ */
const BAD_WORDS = [
  // Insultes directes
  'connard','connarde','salope','pute','enculé','enculee','fils de pute',
  'fdp','pd','pédé','bâtard','batard','merde','chier','foutre','nique',
  'niquer','niqué','ta gueule','gueule','con','conne','abruti','abrutie',
  'imbécile','idiot','idiote','crétin','cretine','débile','demeuré',
  'dégénéré','degenere','ordure','baltringue','bouffon','bouffonne',
  'racaille','peureux','lâche','trouillard','menteur','menteuse',
  'harcèlement','harcelement',
  // Injures graves
  'nazi','pédophile','pedophile','violeur','viol','tuer','tuerai','mort',
  'crever','crève','suicide','se tuer',
].map(w => w.toLowerCase());

function moderateText(text) {
  const lower = (text || '').toLowerCase();
  for (const word of BAD_WORDS) {
    // Cherche le mot avec séparateurs pour éviter les faux positifs
    const re = new RegExp(`(^|[\\s.,!?;:"'\\(\\)])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s.,!?;:"'\\(\\)]|$)`, 'i');
    if (re.test(' ' + lower + ' ')) return false;
  }
  return true;
}

const USER_PUBLIC = {
  select: {
    id: true,
    firstName: true,
    lastName: true,
    role: true,
    jobTitle: true,
    avatarColor: true,
  },
};

function shortName(firstName, lastName) {
  return `${firstName} ${(lastName || '').charAt(0)}.`.trim();
}

function initials(firstName, lastName) {
  return `${(firstName || '')[0] || ''}${(lastName || '')[0] || ''}`.toUpperCase();
}

function roleLabel(role) {
  const map = { DRH: 'DRH', RH: 'RH', MANAGER: 'Manager', ADMIN: 'Admin' };
  return map[role] || '';
}

function formatMsgTime(date) {
  const d = new Date(date);
  const now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 2) {
    return `Maintenant · ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function mapMessage(msg, userId) {
  const u = msg.user;
  const reactions = { '👍': { count: 0, reacted: false } };
  const attachment = msg.file ? {
    id: msg.file.id,
    name: msg.file.originalName,
    mimeType: msg.file.mimeType,
    url: `/api/files/${msg.file.id}`,
  } : null;
  return {
    id: msg.id,
    user: `${u.firstName} ${u.lastName}`,
    initials: initials(u.firstName, u.lastName),
    color: u.avatarColor || '#6B7280',
    role: roleLabel(u.role),
    time: formatMsgTime(msg.createdAt),
    text: msg.text,
    pinned: msg.pinned,
    attachment,
    reactions,
    replies: (msg.replies || []).map((r) => ({
      user: `${r.user.firstName} ${r.user.lastName}`,
      initials: initials(r.user.firstName, r.user.lastName),
      color: r.user.avatarColor || '#6B7280',
      time: new Date(r.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      text: r.text,
    })),
  };
}

// ── GET /api/communication/channels ───────────────────────────
router.get('/channels', authenticate, async (req, res) => {
  const companyId = getCompanyId(req);

  const [channels, memberCount] = await Promise.all([
    prisma.commChannel.findMany({
      where: withCompany(companyId),
      orderBy: { slug: 'asc' },
    }),
    prisma.user.count({ where: withCompany(companyId, { isActive: true }) }),
  ]);

  res.json({
    channels: channels.map((c) => ({
      slug: c.slug,
      label: c.label,
      description: c.description || `${memberCount} membres`,
      memberCount,
    })),
  });
});

// ── GET /api/communication/channels/:slug/messages ────────────
router.get('/channels/:slug/messages',
  authenticate,
  [param('slug').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const channel = await prisma.commChannel.findFirst({
      where: withCompany(companyId, { slug: req.params.slug }),
    });

    if (!channel) {
      return res.status(404).json({ error: 'Canal introuvable.' });
    }

    const messages = await prisma.commMessage.findMany({
      where: { channelId: channel.id, parentId: null },
      include: {
        user: USER_PUBLIC,
        file: { select: { id: true, originalName: true, mimeType: true } },
        replies: {
          include: { user: USER_PUBLIC },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      channel: { slug: channel.slug, label: channel.label, description: channel.description },
      messages: messages.map((m) => mapMessage(m, req.user.id)),
    });
  },
);

// ── POST /api/communication/channels/:slug/messages ───────────
router.post('/channels/:slug/messages',
  authenticate,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Erreur upload.' });
      next();
    });
  },
  [
    param('slug').isString().notEmpty(),
    body('text').optional().isString().trim().isLength({ max: 5000 }),
    body('parentId').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const text = (req.body.text || '').trim();
    if (!text && !req.file) {
      return res.status(400).json({ error: 'Message ou pièce jointe requis.' });
    }

    const companyId = getCompanyId(req);
    const channel = await prisma.commChannel.findFirst({
      where: withCompany(companyId, { slug: req.params.slug }),
    });

    if (!channel) {
      return res.status(404).json({ error: 'Canal introuvable.' });
    }

    let fileId = null;
    if (req.file) {
      const file = await prisma.uploadedFile.create({
        data: {
          userId: req.user.id,
          companyId,
          originalName: req.file.originalname,
          storedName: req.file.filename,
          mimeType: req.file.mimetype,
          size: req.file.size,
          purpose: 'comm_attachment',
        },
      });
      fileId = file.id;
    }

    const created = await prisma.commMessage.create({
      data: {
        channelId: channel.id,
        userId: req.user.id,
        text: text || `📎 ${req.file.originalname}`,
        parentId: req.body.parentId || null,
        fileId,
      },
      include: {
        user: USER_PUBLIC,
        file: { select: { id: true, originalName: true, mimeType: true } },
        replies: { include: { user: USER_PUBLIC } },
      },
    });

    res.status(201).json({ message: mapMessage(created, req.user.id) });
  },
);

/* ═══════════════════════════════════════════════════════════════
   BOÎTE À IDÉES ANONYME
═══════════════════════════════════════════════════════════════ */

const ANON_ANIMALS = [
  'Colibri','Renard','Loup','Hibou','Lynx','Panda','Koala','Aigle',
  'Faucon','Dauphin','Baleine','Jaguar','Tigre','Phénix','Dragon',
  'Bison','Vipère','Gecko','Lapin','Sanglier','Loutre','Marmotte',
  'Flamant','Toucan','Ibis','Castor','Coyote','Puma','Lynx','Oryx',
];

/**
 * Génère un alias anonyme stable pour un user sur une semaine donnée.
 * Même user + même semaine → même alias. Change chaque semaine.
 */
function getWeekKey(date) {
  const d = date ? new Date(date) : new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function buildAnonAlias(userId, weekKey) {
  const hash = crypto.createHash('sha256').update(userId + ':' + weekKey + ':ideabox').digest('hex');
  const animalIdx = parseInt(hash.slice(0, 4), 16) % ANON_ANIMALS.length;
  const num = (parseInt(hash.slice(4, 8), 16) % 99) + 1;
  return `${ANON_ANIMALS[animalIdx]} #${num}`;
}

// ── GET /api/communication/ideabox ────────────────────────────
router.get('/ideabox', authenticate, async (req, res) => {
  const companyId = getCompanyId(req);
  const userId    = req.user.id;

  const posts = await prisma.ideaBoxPost.findMany({
    where: { companyId, status: 'VISIBLE' },
    include: { reactions: { select: { emoji: true, userId: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  const weekKey      = getWeekKey();
  const myAlias      = buildAnonAlias(userId, weekKey);
  const myPost       = await prisma.ideaBoxPost.findFirst({
    where: { companyId, userId, weekKey },
  });

  const formatted = posts.map(p => {
    // Compter les réactions par emoji, signaler si l'utilisateur a réagi
    const byEmoji = {};
    for (const r of p.reactions) {
      if (!byEmoji[r.emoji]) byEmoji[r.emoji] = { count: 0, reacted: false };
      byEmoji[r.emoji].count++;
      if (r.userId === userId) byEmoji[r.emoji].reacted = true;
    }
    return {
      id:        p.id,
      alias:     p.anonAlias,
      text:      p.text,
      time:      formatMsgTime(p.createdAt),
      isOwn:     p.userId === userId, // pour éventuellement montrer "votre idée"
      reactions: byEmoji,
    };
  });

  res.json({
    ideas:        formatted,
    hasPostedThisWeek: !!myPost,
    myAliasPreview: myAlias, // l'alias qu'aura la prochaine publication
  });
});

// ── POST /api/communication/ideabox ───────────────────────────
router.post('/ideabox',
  authenticate,
  [body('text').isString().trim().isLength({ min: 10, max: 1000 })],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const userId    = req.user.id;
    const text      = req.body.text.trim();
    const weekKey   = getWeekKey();

    // Quota : 1 message par semaine
    const existing = await prisma.ideaBoxPost.findFirst({
      where: { companyId, userId, weekKey },
    });
    if (existing) {
      return res.status(429).json({
        error: 'Vous avez déjà publié une idée cette semaine. Revenez la semaine prochaine ! 🗓️',
      });
    }

    // Modération
    if (!moderateText(text)) {
      return res.status(422).json({
        error: 'Votre message contient des mots inappropriés (insultes, harcèlement). Merci de reformuler respectueusement.',
      });
    }

    const anonAlias = buildAnonAlias(userId, weekKey);

    const post = await prisma.ideaBoxPost.create({
      data: { companyId, userId, anonAlias, text, weekKey, status: 'VISIBLE' },
    });

    res.status(201).json({
      idea: {
        id:        post.id,
        alias:     post.anonAlias,
        text:      post.text,
        time:      formatMsgTime(post.createdAt),
        isOwn:     true,
        reactions: {},
      },
    });
  },
);

// ── POST /api/communication/ideabox/:id/react ─────────────────
router.post('/ideabox/:id/react',
  authenticate,
  [
    param('id').isString().notEmpty(),
    body('emoji').isString().trim().isLength({ min: 1, max: 8 }),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const userId    = req.user.id;
    const { emoji } = req.body;

    // Emojis autorisés seulement
    const ALLOWED_EMOJIS = ['👍','💡','❤️','🔥','👏','🙌','🤔','😊'];
    if (!ALLOWED_EMOJIS.includes(emoji)) {
      return res.status(400).json({ error: 'Emoji non autorisé.' });
    }

    const post = await prisma.ideaBoxPost.findFirst({
      where: { id: req.params.id, companyId, status: 'VISIBLE' },
    });
    if (!post) return res.status(404).json({ error: 'Idée introuvable.' });

    // Toggle : si déjà réagi → retirer, sinon → ajouter
    const existing = await prisma.ideaBoxReaction.findFirst({
      where: { postId: post.id, userId, emoji },
    });

    if (existing) {
      await prisma.ideaBoxReaction.delete({ where: { id: existing.id } });
    } else {
      await prisma.ideaBoxReaction.create({
        data: { postId: post.id, userId, emoji },
      });
    }

    // Retourner les nouveaux totaux (anonymes)
    const reactions = await prisma.ideaBoxReaction.findMany({
      where: { postId: post.id },
      select: { emoji: true, userId: true },
    });
    const byEmoji = {};
    for (const r of reactions) {
      if (!byEmoji[r.emoji]) byEmoji[r.emoji] = { count: 0, reacted: false };
      byEmoji[r.emoji].count++;
      if (r.userId === userId) byEmoji[r.emoji].reacted = true;
    }

    res.json({ reactions: byEmoji, toggled: existing ? 'removed' : 'added' });
  },
);

module.exports = router;
