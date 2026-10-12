-- 0003: Buzz direct-message contacts per agent (C57). A row means the agent's first message to this person ran
-- (with the owner's approval when `first_contact` is a held family); later DMs to the same person use `buzz_dm`.
CREATE TABLE connect_buzz_contacts (
  agent TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  channel TEXT NOT NULL,
  first_sent_at INTEGER NOT NULL,
  PRIMARY KEY (agent, pubkey)
);
