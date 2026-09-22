-- Threadvault mirror tables. Idempotent. PHI lives in threadvault_messages.content.

CREATE TABLE IF NOT EXISTS threadvault_threads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id        varchar(255) UNIQUE,
  topic              text,
  created_on         timestamptz,
  created_by_user_id uuid,
  metadata           jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS threadvault_identities (
  our_user_id    uuid NOT NULL,
  acs_id         varchar(255) NOT NULL,
  resource_guid  uuid NOT NULL,
  display_name   text,
  is_system      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (our_user_id, resource_guid)
);

CREATE TABLE IF NOT EXISTS threadvault_participants (
  thread_id    uuid NOT NULL REFERENCES threadvault_threads(id) ON DELETE CASCADE,
  our_user_id  uuid NOT NULL,
  acs_id       varchar(255),
  display_name text,
  PRIMARY KEY (thread_id, our_user_id)
);

CREATE TABLE IF NOT EXISTS threadvault_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id            uuid NOT NULL REFERENCES threadvault_threads(id) ON DELETE CASCADE,
  external_message_id  varchar(255) UNIQUE,
  sender_user_id       uuid,
  sender_is_system     boolean NOT NULL DEFAULT false,
  content              text,
  message_type         varchar(32),
  sent_at              timestamptz NOT NULL,
  edited_at            timestamptz,
  deleted_at           timestamptz,
  metadata             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS threadvault_messages_thread_sent
  ON threadvault_messages (thread_id, sent_at);
