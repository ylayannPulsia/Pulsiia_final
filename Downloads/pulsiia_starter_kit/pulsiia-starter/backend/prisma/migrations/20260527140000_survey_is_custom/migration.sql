-- Sondage RH personnalisé vs QCM journalier rotatif par défaut
ALTER TABLE "Survey" ADD COLUMN "isCustom" BOOLEAN NOT NULL DEFAULT false;
