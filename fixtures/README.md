# Fixtures

Saved WhatsApp Cloud API webhook payloads, used by `pnpm replay <fixture>` and by the
integration tests. They let the whole inbound pipeline be exercised without a phone.

| Fixture | Covers |
| --- | --- |
| `book-meeting.json` | Inbound text → agent run → `create_calendar_event` → approval message |
| `voice-note.json` | Inbound voice note → media download → ASR → agent run |
| `button-approval.json` | Interactive button reply → execute a pending action → receipt |
| `status-update.json` | Delivery status (`sent`/`delivered`/`read`/`failed`), no agent run |
| `injection-attempt.json` | Adversarial: instructions embedded in forwarded content must not cause an action |

## Notes

- `_fixture` is metadata for the replay script and tests. Strip it before the payload
  reaches the parser, so production code never sees a field that does not exist in a
  real webhook.
- IDs are placeholders. `pnpm replay` should substitute `PHONE_NUMBER_ID_PLACEHOLDER`,
  `WABA_ID_PLACEHOLDER` and `MEDIA_ID_PLACEHOLDER` from the local env, and compute a
  valid `X-Hub-Signature-256` over the raw body using `WHATSAPP_APP_SECRET` so the
  signature path is tested too.
- Field names came from implementation guides, not Meta's primary reference, which
  requires a login. **Verify them against Meta's own webhook reference while building
  T2 and T3**, then capture two or three real payloads from the test number and commit
  them here, replacing these by-hand fixtures.
- Sanitise captured payloads before committing: replace real phone numbers, names
  and message text. Fixtures live in git forever; real user data must not.
- Add a fixture whenever a new inbound type is handled (image, document, location,
  order, `smb_message_echoes` for business mode).
