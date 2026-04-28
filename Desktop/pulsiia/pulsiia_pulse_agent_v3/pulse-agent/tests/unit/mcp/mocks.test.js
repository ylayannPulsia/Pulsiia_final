/**
 * Unit tests — Mock MCP tools
 */

const {
  getMockToolsForServers,
  isMockTool,
  executeMockTool,
} = require('../../../src/mcp/mocks');

describe('Mock MCP tools', () => {
  describe('getMockToolsForServers', () => {
    it("retourne les tools Slack quand demandé", () => {
      const tools = getMockToolsForServers(['slack']);
      const names = tools.map((t) => t.name);
      expect(names).toContain('slack_post_message');
      expect(names).toContain('slack_list_channels');
      expect(names).toContain('slack_send_dm');
      expect(names).not.toContain('outlook_create_event');
    });

    it("retourne les tools Outlook + Silae", () => {
      const tools = getMockToolsForServers(['outlook', 'silae']);
      const names = tools.map((t) => t.name);
      expect(names).toContain('outlook_check_availability');
      expect(names).toContain('silae_export_variables');
    });

    it("retourne vide si aucun serveur mocké", () => {
      expect(getMockToolsForServers([])).toEqual([]);
    });

    it("dédoublonne les tools si serveurs partagés", () => {
      const tools = getMockToolsForServers(['slack', 'slack']);
      expect(tools).toHaveLength(3); // les 3 tools Slack uniques
    });
  });

  describe('isMockTool', () => {
    it("identifie les tool names mockés", () => {
      expect(isMockTool('slack_post_message')).toBe(true);
      expect(isMockTool('outlook_create_event')).toBe(true);
      expect(isMockTool('silae_export_variables')).toBe(true);
      expect(isMockTool('lire_planning')).toBe(false);
      expect(isMockTool('inexistant')).toBe(false);
    });
  });

  describe('executeMockTool', () => {
    it("simule slack_post_message", async () => {
      const result = await executeMockTool('slack_post_message', {
        channel: '#planning',
        text: 'Hello',
      });
      expect(result.ok).toBe(true);
      expect(result.channel).toBe('#planning');
      expect(result.message).toMatch(/MOCK/);
    });

    it("simule outlook_check_availability avec dispos aléatoires", async () => {
      const result = await executeMockTool('outlook_check_availability', {
        emails: ['a@x.fr', 'b@x.fr'],
        start: '2026-04-28T09:00:00Z',
        end: '2026-04-28T10:00:00Z',
      });
      expect(result.ok).toBe(true);
      expect(result.disponibilites).toHaveLength(2);
      expect(result.disponibilites[0]).toHaveProperty('libre');
    });

    it("simule silae_export_variables", async () => {
      const result = await executeMockTool('silae_export_variables', {
        periode: '2026-03',
        variable_ids: ['v1', 'v2', 'v3'],
      });
      expect(result.ok).toBe(true);
      expect(result.silae_batch_id).toMatch(/^SLE-/);
      expect(result.variables_exportees).toBe(3);
    });

    it("simule silae_get_bulletins", async () => {
      const result = await executeMockTool('silae_get_bulletins', {
        periode: '2026-03',
      });
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.bulletins)).toBe(true);
      expect(result.bulletins[0]).toHaveProperty('net');
    });

    it("rejette un tool inconnu", async () => {
      await expect(executeMockTool('inexistant', {})).rejects.toThrow();
    });
  });
});
