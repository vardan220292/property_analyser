# Email setup — SES

Client OTP codes and share-link invitations go through the generic SMTP
path in `mailer.py`. AWS SES works with the exact same env vars — nothing
in the app changes, only `.env`.

## 1. SES setup (one-time, in the AWS console)

1. Create an AWS account (or use an existing one) and open **SES** in the
   region closest to your users, e.g. `ap-southeast-2` (Sydney).
2. **Verify a domain** (Identities → Create identity → Domain):
   - Add the DKIM CNAME records SES shows at your DNS provider.
   - Verify the domain, not just a single address — lets you send from
     any `@yourdomain.com` sender.
3. **Request production access** (Account dashboard → Request production
   access). New SES accounts start in the SANDBOX: they can only send to
   verified addresses. Approvals usually take a day; state your use case
   ("transactional — sign-in codes and document links sent to our own
   registered users").
4. **Create SMTP credentials** (SMTP settings → Create SMTP credentials).
   This makes an IAM user whose password works only for SES SMTP — do NOT
   use root keys. Note the hostname shown, e.g.
   `email-smtp.ap-southeast-2.amazonaws.com`, port 587 (STARTTLS).
5. **SPF**: add a TXT record `v=spf1 include:amazonses.com ~all` to the
   domain. DKIM came from step 2; DMARC is optional but recommended
   (`v=DMARC1; p=none;` to start).

## 2. .env

```
PA_SMTP_HOST=email-smtp.ap-southeast-2.amazonaws.com
PA_SMTP_PORT=587
PA_SMTP_USER=AKIA...          # SES SMTP username
PA_SMTP_PASS=...              # SES SMTP password
PA_SMTP_FROM=proposals@yourdomain.com
PA_BASE_URL=https://yourdomain.com
```

`PA_BASE_URL` must be the address clients can reach — share links are
built from it. Without SMTP configured, codes and links are logged to the
server console instead (dev/test mode) and the UI says so.

## 3. Verify

- Restart the app, then: register a client via a share link → the OTP
  code should arrive by email.
- Watch SES → Account dashboard → Sending statistics for bounces/complaints.
- Bounce or complaint rates above ~5% get your account throttled; the app
  only mails its own users, so this stays quiet.

## Costs

SES is $0.10 per 1,000 emails from an EC2/VPS in the same region (elsewhere
$0.12/1,000 after the free tier). At BA scale this rounds to zero.
