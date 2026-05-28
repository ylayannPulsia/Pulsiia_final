-- QCM journalier : une réponse par utilisateur et par jour (plus une seule par semaine)

ALTER TABLE "SurveyResponse" ADD COLUMN "responseDate" TIMESTAMP(3);

UPDATE "SurveyResponse"
SET "responseDate" = date_trunc('day', "createdAt")
WHERE "responseDate" IS NULL;

ALTER TABLE "SurveyResponse" ALTER COLUMN "responseDate" SET NOT NULL;

DROP INDEX IF EXISTS "SurveyResponse_surveyId_userId_key";

CREATE UNIQUE INDEX "SurveyResponse_surveyId_userId_responseDate_key"
  ON "SurveyResponse"("surveyId", "userId", "responseDate");

CREATE INDEX "SurveyResponse_responseDate_idx" ON "SurveyResponse"("responseDate");
