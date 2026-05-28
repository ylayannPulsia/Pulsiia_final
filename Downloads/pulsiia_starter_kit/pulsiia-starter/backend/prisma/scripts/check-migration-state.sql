SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CompanyInvitation') AS has_invitations;
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'IdeaBoxPost') AS has_ideabox;
SELECT indexname FROM pg_indexes WHERE tablename = 'User' AND indexname LIKE '%email%';
