# Threat model — > **Почему Free пока нельзя пустить так же, как Paid.** Бесплатный Start Plan с…

Goal: > **Почему Free пока нельзя пустить так же, как Paid.** Бесплатный Start Plan сервер выдаёт только сессии приложения. Хост приложения передаёт его своим внутренним процессам. Отдельно запущенный движок, как у Paid, Start Plan не получает. Это я проверил ещё утром.

вот как мы можем все это программно воссоздать чтобы могли приложение держать просто свернутым? Без проблемной работы и большей интегрированность чтобы была с бб

## Security risks named by the analysis
- If session JWT is read from `~/.zcode/v2/credentials.json`, the decryption key and token must never be logged, committed, or exposed outside 0600 local process memory.

## What the plan must hold
- every piece that touches these risks names them in its acceptance and carries a check for them
- no secret, credential or permission is widened without a check that would fail if it were

Written by Lane Pilot from the analysis (lp.analyze); the planner and the plan critic read it with CONTEXT.md.