/**
 * Pulse Agent — Tool Definitions
 * Schémas conformes à l'API Anthropic Messages (tool use).
 * Chaque tool correspond à une action métier sur un module Pulsiia.
 */

const TOOL_DEFINITIONS = [
  // ────────────────────────────────────────────────────────────
  // PLANNING
  // ────────────────────────────────────────────────────────────
  {
    name: 'lire_planning',
    description:
      "Récupère le planning d'une période donnée pour un établissement ou un collaborateur. " +
      'Utiliser quand l\'utilisateur demande à voir, consulter, ou analyser des shifts. ' +
      'Retourne les shifts avec horaires, type (matin/après-midi/nuit), et statut.',
    input_schema: {
      type: 'object',
      properties: {
        date_debut: {
          type: 'string',
          description: 'Date de début au format YYYY-MM-DD',
        },
        date_fin: {
          type: 'string',
          description: 'Date de fin au format YYYY-MM-DD',
        },
        etablissement_id: {
          type: 'string',
          description: 'ID de l\'établissement (optionnel, sinon tous les établissements accessibles)',
        },
        collaborateur_id: {
          type: 'string',
          description: 'ID du collaborateur pour filtrer (optionnel)',
        },
      },
      required: ['date_debut', 'date_fin'],
    },
  },
  {
    name: 'detecter_postes_decouverts',
    description:
      'Détecte les postes non couverts (shifts vides, absences non remplacées) sur une période. ' +
      'À utiliser quand l\'utilisateur demande "y a-t-il des trous ?", "qu\'est-ce qui manque cette semaine ?", ou face à une alerte de poste découvert.',
    input_schema: {
      type: 'object',
      properties: {
        date_debut: { type: 'string', description: 'YYYY-MM-DD' },
        date_fin: { type: 'string', description: 'YYYY-MM-DD' },
        etablissement_id: { type: 'string', description: 'Optionnel' },
      },
      required: ['date_debut', 'date_fin'],
    },
  },
  {
    name: 'suggerer_remplacement',
    description:
      'Propose des collaborateurs disponibles pour remplacer un shift donné, en tenant compte ' +
      'des compétences requises, des heures déjà travaillées, et des préférences. Utiliser quand un poste est découvert ou une absence à remplacer.',
    input_schema: {
      type: 'object',
      properties: {
        shift_id: {
          type: 'string',
          description: 'ID du shift à remplacer',
        },
        max_suggestions: {
          type: 'integer',
          description: 'Nombre max de candidats à proposer (défaut 3)',
          default: 3,
        },
      },
      required: ['shift_id'],
    },
  },
  {
    name: 'creer_shift',
    description:
      'Crée un nouveau shift dans le planning. Action sensible : Pulse doit toujours confirmer ' +
      'avec l\'utilisateur les détails avant exécution (collaborateur, date, horaires).',
    input_schema: {
      type: 'object',
      properties: {
        collaborateur_id: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        heure_debut: { type: 'string', description: 'HH:MM' },
        heure_fin: { type: 'string', description: 'HH:MM' },
        type_shift: {
          type: 'string',
          enum: ['matin', 'apres_midi', 'nuit', 'journee'],
        },
        etablissement_id: { type: 'string' },
      },
      required: [
        'collaborateur_id',
        'date',
        'heure_debut',
        'heure_fin',
        'type_shift',
        'etablissement_id',
      ],
    },
  },

  // ────────────────────────────────────────────────────────────
  // PRÉ-PAIE
  // ────────────────────────────────────────────────────────────
  {
    name: 'lister_variables_paie',
    description:
      'Liste les variables de paie d\'une période (heures supp, absences, primes, majorations) ' +
      'avec leur statut (à valider, validé, anomalie). Utiliser pour aperçu avant clôture.',
    input_schema: {
      type: 'object',
      properties: {
        periode: {
          type: 'string',
          description: 'Format YYYY-MM (ex: "2026-03" pour mars 2026)',
        },
        statut: {
          type: 'string',
          enum: ['tous', 'a_valider', 'valide', 'anomalie'],
          default: 'tous',
        },
        etablissement_id: { type: 'string', description: 'Optionnel' },
      },
      required: ['periode'],
    },
  },
  {
    name: 'valider_variable_paie',
    description:
      'Valide une variable de paie. Action sensible : ne jamais exécuter sans confirmation explicite ' +
      'de l\'utilisateur. Génère un audit log automatique (RGPD).',
    input_schema: {
      type: 'object',
      properties: {
        variable_id: { type: 'string' },
        commentaire: {
          type: 'string',
          description: 'Commentaire optionnel pour l\'audit log',
        },
      },
      required: ['variable_id'],
    },
  },
  {
    name: 'detecter_anomalies_paie',
    description:
      'Lance la détection IA d\'anomalies sur les variables de paie d\'une période ' +
      '(écarts vs historique, incohérences planning↔paie, dépassements légaux).',
    input_schema: {
      type: 'object',
      properties: {
        periode: { type: 'string', description: 'YYYY-MM' },
      },
      required: ['periode'],
    },
  },

  // ────────────────────────────────────────────────────────────
  // BIEN-ÊTRE
  // ────────────────────────────────────────────────────────────
  {
    name: 'analyser_bienetre_equipe',
    description:
      'Analyse le score bien-être d\'une équipe sur une période, avec tendance et signaux faibles ' +
      '(charge, soutien, humeur). Données toujours anonymisées (RGPD).',
    input_schema: {
      type: 'object',
      properties: {
        equipe_id: { type: 'string', description: 'Optionnel — sinon global' },
        etablissement_id: { type: 'string', description: 'Optionnel' },
        periode_jours: {
          type: 'integer',
          description: 'Nombre de jours de recul (défaut 30)',
          default: 30,
        },
      },
    },
  },
  {
    name: 'predire_turnover',
    description:
      'Calcule un score de risque de turnover pour une équipe ou un collaborateur, basé sur ' +
      'corrélation multi-facteurs (bien-être, heures supp, absences, ancienneté).',
    input_schema: {
      type: 'object',
      properties: {
        equipe_id: { type: 'string', description: 'Optionnel' },
        collaborateur_id: { type: 'string', description: 'Optionnel' },
      },
    },
  },

  // ────────────────────────────────────────────────────────────
  // ROI / RAPPORTS
  // ────────────────────────────────────────────────────────────
  {
    name: 'calculer_roi_mensuel',
    description:
      'Calcule le ROI Pulsiia du mois courant ou d\'un mois donné : économies, heures RH ' +
      'économisées, bulletins rectifiés évités. Utiliser pour démos client et reporting direction.',
    input_schema: {
      type: 'object',
      properties: {
        periode: {
          type: 'string',
          description: 'YYYY-MM (défaut : mois courant)',
        },
      },
    },
  },
];

module.exports = { TOOL_DEFINITIONS };
