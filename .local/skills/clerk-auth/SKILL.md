---
name: clerk-auth
description: "Default user authentication solution. You MUST load this skill for: 1) Any authentication, login, signup, or user account request (unless the user explicitly asks for Replit Auth, Sign in with Replit, or Replit SSO, or wants to revert/rollback from Clerk to Replit Auth — in those cases, use the replit-auth skill instead) 2) Any question related to customizing Google/Apple/GitHub/X login pages (e.g. \"add Apple login\", \"change my Google login page text or logo\", \"[screenshot of Google login page] + make this say 'continue with <app name>'\") 3) Any question related to Clerk email verification or factual inquiries such as supported features, MAU limit, fees, etc 4) Requests to migrate an app from Replit Auth to Clerk. Failure to read this skill can lead to the user misconfiguring their auth and getting stuck in a bad state."
---

# Clerk Auth

## Overview

Clerk Auth gives the user's app its own dedicated authentication system, powered by a Replit-provisioned Clerk tenant. End users sign up in the app and the builder gets full control over branding and login methods.
- **Replit-managed**: Replit provisions the Clerk tenants and key automatically. No need to touch accounts/secrets manually and no Clerk dashboard access.
- **Two isolated environments**: Development and Production have separate user stores — accounts/data do not cross over. Test keys are used during development and automatically swapped to live keys when the app is published.
- **Login methods**: email/password (with email verification) and SSO via Google, GitHub, Apple, and X; custom OAuth credentials supported in Production for branded consent screens
- **Managed from the Auth pane**: user management and consent screen configuration managed from the builtin Auth pane
- **Not supported today**: SMS/phone sign-in, MFA, organization tenants

## When to Use

- User wants authentication, login, signup, or user accounts (this is the default)
- User wants custom branding on login/signup screens
- User wants their own user database
- Any generic auth request that does not explicitly mention "Replit Auth", "Sign in with Replit", or "Replit SSO"

## Step 1: Check Clerk Management Status

ALWAYS call `checkClerkManagementStatus` before taking any action. Failing to do so can cause extreme user confusion and lead the user to get into a bad state with their app.

```javascript
const status = await checkClerkManagementStatus();
console.log(status);
```

DO NOT proceed with steps 2 and 3 until you have done step 1 and know if the user is using Replit-managed clerk or their own external clerk account.

## Step 2: Route Based on Status

**`external`**: The user is managing their own Clerk instance. This skill does not apply — stop here.

**`unknown`**: DO NOT proceed to Step 3. Ask the user: "Are you using Replit-managed Clerk (set up automatically) or your own external Clerk account? Check if the Clerk publishable key stored in secrets matches your own personal Clerk account. If so, it is external." DO NOT say anything more than just this question.

**`not_configured`**: Neither Replit-managed or external Clerk has been set up — continue to step 3.

**`managed`**: Replit-managed Clerk already set up — continue to step 3.

## Step 3: Route Based on Request Type

IMPORTANT: DO NOT start this step if the management status you found was unknown or external.

Identify the user's intent and follow the matching section below.

### Intent: Inquiry, Configuration, Login Providers, and Setup Questions

The user is asking a factual or conceptual question about Clerk Auth (how something works, whether a feature is supported, pricing, setup requirements, configuration options, environment behavior, etc.) or is asking you to change their login providers, OAuth credentials, or consent screen branding. ALWAYS call `searchReplitDocs` first — do not answer from prior knowledge.

```javascript
const result = await searchReplitDocs({ query: "<query>" });
console.log(result.response);
```

Common question categories and example queries:

- **Login providers, OAuth credentials, SSO, consent screen branding, or Auth pane questions**
  - Example question: "How do I add Apple login?"
  - Example query: `"Configure custom <provider_name> OAuth credentials for Clerk Auth"`
  - After the search, direct the user to the **Auth pane** in the workspace toolbar.
- **Clerk DNS, custom domain, email verification, DKIM, or SPF setup questions**
  - Example question: "How do I set up Clerk DNS for email verification?"
  - Example query: `"Set up Clerk DNS for email verification"`
- **Clerk Auth feature support (e.g. MFA, organizations, passkeys, magic links, webhooks)**
  - Example question: "Does Clerk Auth support passkeys?"
  - Example query: `"Does Clerk Auth support <feature>"`
- **Clerk Auth pricing, MAU limits, quotas, or plan tier questions**
  - Example question: "Does Clerk Auth have a MAU limit?"
  - Example query: `"Clerk Auth MAU limit and pricing"`
- **Live vs test keys (`pk_test` / `sk_test` vs `pk_live` / `sk_live`)**
  - Example question: "My Clerk publishable key starts with `pk_test` — how do I switch to a live key?"
  - Example query: `"Clerk Auth test vs live keys for development and production"`
- **Sign-in, sign-up, or user management questions (e.g. missing accounts or data)**
  - Example question: "Why can't I sign in to my published app with the account I made during development?"
  - Example query: `"Clerk Auth development vs production environment user separation"`

### Intent: Implementation & Changes

The user wants to set up Clerk, integrate it into their code, customize the sign-in page, or troubleshoot a broken integration. Read `.local/skills/clerk-auth/references/setup-and-customization.md` for guidance.

### Intent: Migrating from Replit Auth

Migrating an app from Replit Auth to Clerk is not currently supported. Tell the user that automated migration is not yet available and stop — do not attempt a manual migration.

