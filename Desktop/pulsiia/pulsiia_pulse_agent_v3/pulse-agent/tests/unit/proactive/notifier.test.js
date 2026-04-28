/**
 * Unit tests — Notifier
 */

const { Notifier } = require('../../../src/proactive/notifier');
const { SEVERITY } = require('../../../src/proactive/rules');

describe('Notifier', () => {
  let adapters, prisma, notifier;

  beforeEach(() => {
    adapters = {
      websocket: { send: jest.fn().mockResolvedValue(true) },
      email: { send: jest.fn().mockResolvedValue(true) },
      pwa: { push: jest.fn().mockResolvedValue(true) },
      slack: { send: jest.fn().mockResolvedValue(true) },
      teams: { send: jest.fn().mockResolvedValue(true) },
    };
    prisma = {
      proactiveAlertSent: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    notifier = new Notifier({ adapters, prisma, logger: console });
  });

  const baseAlert = {
    rule: 'planning.uncovered_shift_24h',
    severity: SEVERITY.CRITICAL,
    title: 'Poste découvert',
    body: 'Samedi 14h cuisine non couvert',
    target: { type: 'shift', id: 's1' },
  };

  const baseUser = {
    id: 'u1',
    email: 'marie@saveurs.fr',
    prenom: 'Marie',
    tenantId: 't1',
    slackWebhookUrl: 'https://hooks.slack.com/xxx',
    teamsWebhookUrl: 'https://outlook.com/webhook/xxx',
  };

  it('envoie sur websocket + email + pwa', async () => {
    const result = await notifier.send(baseAlert, baseUser, ['websocket', 'email', 'pwa']);
    expect(adapters.websocket.send).toHaveBeenCalledWith('u1', expect.any(Object));
    expect(adapters.email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'marie@saveurs.fr',
        subject: expect.stringMatching(/Poste découvert/),
      })
    );
    expect(adapters.pwa.push).toHaveBeenCalledWith('u1', expect.any(Object));
    expect(result.websocket.ok).toBe(true);
    expect(result.email.ok).toBe(true);
    expect(result.pwa.ok).toBe(true);
  });

  it('envoie sur slack avec format blocks', async () => {
    await notifier.send(baseAlert, baseUser, ['slack']);
    const [url, payload] = adapters.slack.send.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/xxx');
    expect(payload.blocks).toBeDefined();
    expect(payload.blocks[0].type).toBe('header');
  });

  it('envoie sur teams avec MessageCard format', async () => {
    await notifier.send(baseAlert, baseUser, ['teams']);
    const payload = adapters.teams.send.mock.calls[0][1];
    expect(payload['@type']).toBe('MessageCard');
    expect(payload.themeColor).toBeDefined();
  });

  it('signale erreur si webhook Slack absent', async () => {
    const userNoSlack = { ...baseUser, slackWebhookUrl: null };
    const result = await notifier.send(baseAlert, userNoSlack, ['slack']);
    expect(result.slack.ok).toBe(false);
    expect(result.slack.error).toMatch(/Slack/);
    expect(adapters.slack.send).not.toHaveBeenCalled();
  });

  it("persiste l'envoi en DB", async () => {
    await notifier.send(baseAlert, baseUser, ['websocket']);
    expect(prisma.proactiveAlertSent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        ruleId: 'planning.uncovered_shift_24h',
        severity: SEVERITY.CRITICAL,
        targetType: 'shift',
        targetId: 's1',
      }),
    });
  });

  it('continue les autres canaux si un échoue', async () => {
    adapters.email.send.mockRejectedValue(new Error('SMTP down'));
    const result = await notifier.send(baseAlert, baseUser, ['websocket', 'email', 'pwa']);
    expect(result.websocket.ok).toBe(true);
    expect(result.email.ok).toBe(false);
    expect(result.pwa.ok).toBe(true);
  });

  it("échappe le HTML dans les emails", async () => {
    const malicious = {
      ...baseAlert,
      title: '<script>alert(1)</script>',
      body: 'safe & sound',
    };
    await notifier.send(malicious, baseUser, ['email']);
    const html = adapters.email.send.mock.calls[0][0].html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('safe &amp; sound');
  });
});
