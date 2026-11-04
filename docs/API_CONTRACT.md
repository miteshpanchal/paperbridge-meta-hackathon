# External platform contract

The producer has no direct access to the destination database. It sends server-to-server requests using `Authorization: Bearer <service-key>`. The browser never receives that credential.

## Publish

`POST {CLARIFYCUE_API_URL}/integrations/papers`

```json
{
  "externalId": "stable-paper-uuid",
  "name": "Physics practice paper",
  "description": "Digitized paper; AI-derived key unless stated otherwise",
  "examId": "existing-destination-exam-id",
  "durationMins": 10,
  "marksPerQuestion": 4,
  "negativeMarking": true,
  "questions": [
    {
      "text": "Question text with $LaTeX$",
      "imageUrl": "data:image/png;base64,...",
      "explanation": "Worked solution",
      "options": [
        {
          "text": "Choice A\n\n![Option diagram](data:image/png;base64,...)",
          "isCorrect": false
        },
        { "text": "Choice B", "isCorrect": true }
      ]
    }
  ]
}
```

Single-correct questions require exactly one correct answer. Question order and option order must be preserved. The receiver saves questions, options, test and ordered links in one transaction. Retries of the same `externalId` and payload return the same test; changed payloads return 409. Configure a different service credential for each producer in a future multi-tenant adapter; the current example uses one configured producer.

```json
{
  "testId": "actual-platform-id",
  "name": "Physics practice paper",
  "examId": "existing-destination-exam-id",
  "questionCount": 3,
  "durationMins": 10,
  "totalMarks": 12,
  "isPublished": true,
  "source": "EXTERNAL_PAPER_API",
  "externalId": "stable-paper-uuid",
  "studentLibraryUrl": "https://demo.example/app/#/tests",
  "createdAt": "ISO-8601 timestamp",
  "reused": false
}
```

## Verify publication

`GET {CLARIFYCUE_API_URL}/integrations/papers/{testId}`

Returns the persisted receipt, without answer keys. The producer requires matching `testId`, `externalId`, question count and published status. It adds `readBackVerifiedAt` only after this succeeds. Network failures and non-2xx responses produce an error, never a substitute receipt.

The ClarifyCue example has a narrow service guard, disabled when its 32+ character `EXTERNAL_PAPER_API_KEY` is unset. It cannot authenticate a platform user or access general admin routes. It requires an explicit existing exam ID, preventing accidental publication to an arbitrary exam.

The independent PaperBridge test supports configurable marks and penalties. The current ClarifyCue adapter sends its standard negative-marking flag, so PaperBridge allows a 25% penalty ratio or zero penalty for that destination. More advanced exam formats and arbitrary destination marking schemes need an expanded contract.
