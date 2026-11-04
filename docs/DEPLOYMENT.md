# Deploy separately, keep the ClarifyCue domain

Repository: https://github.com/miteshpanchal/paperbridge-meta-hackathon

The public repository builds its own service. The private ClarifyCue repository remains private and deploys independently. Domain routing does not combine their source code.

## URL choices

| URL                         | Routing                                                                  | Main app impact                                                      |
| --------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `hackathon.clarifycue.com`  | Host rule to the new service, or a separate Firebase Hosting site/domain | Independent host; easiest to isolate                                 |
| `clarifycue.com/hackathon/` | Firebase rewrite or HTTPS load balancer path rule                        | Change routing in front of the apps; main app source need not change |
| Separate `run.app` URL      | Cloud Run's service URL                                                  | Fastest preview; attach domain later                                 |

Google's [custom domain guide](https://docs.cloud.google.com/run/docs/mapping-custom-domains) lists load balancing and Firebase Hosting as options. Direct Cloud Run domain mapping cannot select a URL path. See [serverless load balancer routing](https://docs.cloud.google.com/load-balancing/docs/https/setup-global-ext-https-serverless) for host/path rules.

## Run the container

Deploy this directory as its own build context. Set:

```text
HOST=0.0.0.0
PORT=8080
APP_URL=https://hackathon.clarifycue.com
BASE_PATH=
DATA_BUCKET=<dedicated-private-hackathon-bucket>
JUDGE_EMAIL=<private judge email>
JUDGE_PASSWORD=<random password, at least 12 characters>
SESSION_SECRET=<random secret, at least 32 characters>
MODEL_API_KEY=<Meta API key>
CLARIFYCUE_API_URL=https://<dedicated-core-demo>/api
CLARIFYCUE_PAPER_API_KEY=<matching narrow service key>
CLARIFYCUE_EXAM_ID=<existing demo exam ID>
```

For a path mount use `APP_URL=https://clarifycue.com/hackathon` and `BASE_PATH=/hackathon`. Assets, API requests, shared links and the judge cookie are then scoped to that prefix. Route the original full path to this service; do not strip `/hackathon` when using `BASE_PATH`.

Use Secret Manager or your provider's secret settings for credentials. Never add `.env` or local access files to the public repository.

**Storage:** Cloud Run's local writable filesystem is ephemeral. Set `DATA_BUCKET` to use the included private Cloud Storage adapter. Grant the attached service account object read/create/update permissions only on that dedicated bucket. Reads pin an object generation; writes use generation preconditions to reject stale concurrent mutations. A conflict returns 409 and asks the caller to refresh/retry; it never silently overwrites another update. Configure a bucket lifecycle policy for uploaded-paper retention. Keep the bucket private and separate from ClarifyCue assets. Start with one instance for predictable demo costs and inference throughput.

The local file adapter is still available when `DATA_BUCKET` is unset. Use it with a persistent Docker volume and only one Node process; it is not durable on default Cloud Run storage.

**Uploads/model calls:** Set an application request timeout long enough for per-page sequential model work. Cloud Run's HTTP/1 request-size limit may be lower than the portal's 25 MB source-file limit once base64 JSON encoding is added; configure the displayed upload limit for your deployment or use direct object-storage uploads before accepting maximum-size papers publicly. API processing is synchronous per page in this release.

## Firebase Hosting path routing example

If Firebase Hosting already fronts `clarifycue.com`, add these rules **before** its existing catch-all, preserving all unrelated configuration:

```json
[
  {
    "source": "/hackathon",
    "run": { "serviceId": "paperbridge-hackathon", "region": "asia-south1" }
  },
  {
    "source": "/hackathon/**",
    "run": { "serviceId": "paperbridge-hackathon", "region": "asia-south1" }
  },
  {
    "source": "**",
    "run": {
      "serviceId": "EXISTING-CLARIFYCUE-SERVICE",
      "region": "EXISTING-REGION"
    }
  }
]
```

This is a routing example, not an instruction to overwrite an existing Firebase configuration. Verify the real project, site ID, domain owner, request-duration limits and existing routes before deployment. Firebase Hosting can impose a shorter request deadline than the AI pipeline; for long inference requests use a Cloud Run API origin designed for that purpose or a job/polling architecture instead of assuming rewrites extend that deadline.

## Before submitting the judge URL

1. Verify the public URL, TLS, login and persistent storage through a restart.
2. Set the Meta key and verify each model using an unseen paper and a spoken doubt.
3. Deploy the generic destination adapter to a dedicated ClarifyCue demo deployment; set its narrow service key and target exam.
4. Run publish → read-back → hosted attempt → response analysis from the same judge workspace.
5. Share the public repository, URL and judge credentials through the submission form. Keep actual API and session secrets private.
