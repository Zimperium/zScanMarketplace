# Zimperium zScan GitHub Action

## Mobile Application Security Testing

The zimperium-zscan action scans your mobile app binary (ios or android) and identifies the security, privacy, and compliance-related vulnerabilities.

## Features

    - Identify risks and provide recommendations to mitigate the risk
    - Highlights the vulnerable code snippet
    - Lists the locations where the vulnerable code snippet was found
    - Integrates with GitHub Advanced Security (GHAS) to display issues and     remediation information inside of GitHub code scanning alerts (SARIF report download required)
    - Run scans for each merge or pull request
    - Break workflow if certain scan criteria are met

## Example Workflow

    ```yaml
    - name: Run Zimperium zScan
        uses: zimperium/zscanmarketplace@v1.4
        timeout-minutes: 60
        with:
            console_url: https://zc202.zimperium.com
            client_id: <Paste CLIENT_ID here or use a GitHub variable>
            client_secret: ${{ secrets.ZSCAN_CLIENT_SECRET }}
            app_file: ./Sample_Insecure_Bank_App.apk
            team_name: Default
            report_format: sarif
            fail_on_scan_findings: false

    - name: Upload SARIF file
        uses: github/codeql-action/upload-sarif@v4
        with:  
            sarif_file: Sample_Insecure_Bank_App_zscan.sarif
    ```

### Report formats

The action supports `json`, `sarif`, and `pdf` through the `report_format` input:

| Value | Result |
| --- | --- |
| `sarif` | SARIF only (default) |
| `json` | JSON only |
| `pdf` | PDF only |
| `sarif, pdf` | Both SARIF and PDF |
| `all` | SARIF, JSON, and PDF |

Formats may be separated by commas or whitespace and are case-insensitive. Unsupported values are ignored with a warning; if no supported value remains, the action falls back to `sarif`.

**Requesting multiple formats performs exactly one app upload and one zScan assessment.** Every requested report is downloaded from that same assessment ID, so you never need to invoke the action more than once to collect multiple reports.

Reports are named after the application file with a `_zscan` suffix and the format extension, for example `Sample_Insecure_Bank_App_zscan.sarif` and `Sample_Insecure_Bank_App_zscan.pdf`. Each requested report is verified as written to disk and non-empty before the action succeeds.

### Workflow gating

Set `fail_on_scan_findings` to `true` to fail the workflow when findings meet the configured criteria. Use `scan_evaluation_mode` with `any_finding` (default) or `unaccepted_finding_only`, and set `minimum_severity` to `informational`, `low` (default), `medium`, `high`, or `critical`. `Best Practices` findings are excluded from gating.

When gating is enabled the action needs the JSON report. If you did not request `json`, it is fetched automatically **from the same assessment** — this does not trigger an additional upload or scan, and the extra JSON report is not added to your requested outputs.

When scan finding evaluation is enabled, the action prints a severity summary with total and unaccepted finding counts, followed by whether the configured evaluation criteria were met.

### Reliability behavior

**Upload retries.** Uploads are retried on transient failures: HTTP `408`, `429`, `500`, `502`, `503`, `504`, plus network-level errors such as `ECONNRESET` and `ETIMEDOUT`. Authentication failures (`401`/`403`), validation errors, and other non-transient `4xx`/`5xx` responses (e.g. `400`, `501`) are never retried and fail immediately. Retries use bounded attempts with exponential backoff. When several app files are matched, a failed upload is reported explicitly and never produces a success-shaped result; the action fails if any file fails.

**Status polling.** The action polls the assessment status every 30 seconds for up to 45 minutes by default. Transient `404`, `408`, `429`, `500`, `502`, `503`, `504` responses are treated as "not ready yet" rather than errors, since the service returns these while the scan is still in progress. Status payloads are validated before any field is read, so a malformed or incomplete response produces an actionable error instead of an undefined dereference.

**Report download.** Each requested report is polled for up to 20 minutes by default. PDF reports are retrieved by first requesting the assessment report metadata, reading the returned `cdn_link`, and immediately downloading from that URL (the link is short-lived). Transient `404`, `425`, `408`, `429`, `500`, `502`, `503`, `504`, and network errors are retried; missing `cdn_link` values, malformed responses, authentication failures, and other non-transient errors fail immediately without retrying.

**Failure modes.** The action fails with a clear, actionable message when analysis reports `Failed`, when status polling times out, when status responses are repeatedly malformed, when a requested report cannot be downloaded before its timeout, or when a report file is missing or empty.

### Retry and timeout configuration

All of these are optional and have bounded defaults, so existing workflows need no changes. Invalid values fail the action with an explicit message.

| Input | Default | Range | Purpose |
| --- | --- | --- | --- |
| `retry_attempts` | `3` | 1–10 | Attempts for transient upload/API failures |
| `retry_delay_seconds` | `5` | 0–60 | Initial delay between retries |
| `retry_backoff_factor` | `2` | 1–5 | Exponential backoff multiplier |
| `status_timeout_minutes` | `45` | 1–360 | Max wait for analysis to complete |
| `status_poll_interval_seconds` | `30` | 5–300 | Interval between status checks |
| `report_timeout_minutes` | `20` | 1–180 | Max wait for each report |
| `report_poll_interval_seconds` | `6` | 1–120 | Interval between download attempts |

### Complete multiformat example

    ```yaml
    - name: Run Zimperium zScan
        uses: zimperium/zscanmarketplace@v1.4
        timeout-minutes: 60
        with:
            console_url: https://zc202.zimperium.com
            client_id: ${{ vars.ZSCAN_CLIENT_ID }}
            client_secret: ${{ secrets.ZSCAN_CLIENT_SECRET }}
            app_file: ./Sample_Insecure_Bank_App.apk
            team_name: Default
            report_format: sarif, pdf
            fail_on_scan_findings: true
            scan_evaluation_mode: unaccepted_finding_only
            minimum_severity: high

    - name: Upload SARIF file
        uses: github/codeql-action/upload-sarif@v4
        with:
            sarif_file: Sample_Insecure_Bank_App_zscan.sarif

    - name: Archive PDF report
        uses: actions/upload-artifact@v4
        with:
            name: zscan-pdf-report
            path: Sample_Insecure_Bank_App_zscan.pdf
    ```

The single step above uploads the app once, runs one scan, and produces both `Sample_Insecure_Bank_App_zscan.sarif` and `Sample_Insecure_Bank_App_zscan.pdf`.

## GitHub Prerequisites

- If you use an Enterprise GitHub account, you need a GitHub Advanced Security (GHAS) license to import zScan results into your repository's Security Dashboard.  Alternatively, you can skip uploading the SARIF file and/or generate reports as a JSON or PDF.
- If you use a Public repository, GHAS, and Code Scanning are already enabled by default.

## Get Started

### Step 1 - Get API Keys

    1. Log in to the zConsole user interface zScan platform.
    2. Click the Account Management gear icon.
    3. Click the Authorizations menu item.
    4. Click the + Generate API Key button.
    5. Enter a description and select the zScan needed permissions at the bottom. Select View for all permissions except for zScan Builds and click Upload for it.
    6. Click the Save API Access button.
    7. Click the copy icons and store both the client ID (CLIENT_ID) and the client secret (ZSCAN_CLIENT_SECRET) values.
    8. Click Close.​

### Step 2 - Enable GHAS in GitHub (Enterprise GitHub accounts only)

You need to enable GHAS to display issues and remediation information inside of GitHub code scanning alerts. Once you acquire the GHAS license, follow the instructions below to enable GHAS.

**Please Note:** If you are using a Public repository, GHAS, and Code Scanning are already enabled for you by default.

1. Click the Settings tab in your GitHub account.
2. Click Code Security and Analysis on the left navigation pane under the Security section.
3. Click Enable for GitHub Advanced Security and confirm the setting. This permits code scanning and secret scanning.
4. Under GHAS, ensure that Code Scanning is enabled. This is a required step.

### Step 3 - Add a Repository Secret in GitHub Repository

The secret is being added so that you can use it in the zScan workflow next. Follow the instructions below to add a secret.

1. Within a Repository, go to Settings. Under Security, select “Secrets and Variables” and then “Actions.”
2. Click the “New repository secret” button.
3. Enter ZSCAN_CLIENT_SECRET in the Name field.
4. Enter the API Secret Key you obtained from Step 1
5. Click "Add secret".

For more information, see [GitHub Documentation](https://docs.github.com/en/actions/concepts/workflows-and-actions/variables).  You can also use a variable for the Client ID, if you prefer.

### Step 4 - Add and Configure zSCAN Workflow in GitHub

1. Click the "Security" tab in your repository (GHAS must be enabled).
2. Click "Set up code scanning" under “Vulnerability Alert” on the left navigation pane.
3. Click “Configure Scanning Tool”.
4. Under the Code Scanning section, click “Explore Workflows”.
5. Enter “zScan” in the search box and hit enter.
6. The zScan action is displayed. Click the “Configure” button.
7. The zScan.yml file will automatically be opened.
8. Click the Edit button and make the following changes in the zscan.yml file.
9. Change the value for console_url to the host portion of your console URL, e.g., <https://zc202.zimperium.com>.
10. Upload the app you want to scan and change the value of the app_file variable.

    - You need to change the value of the "app_file" variable to indicate the app name and its location in the workspace, e.g., the output folder.
    - This parameter accepts wildcards; however, the wildcard pattern should not match more than 5 files.

11. Click “Commit changes” and “Commit directly to the main branch” or create/approve/merge a Pull Request.
12. Committing the changes automatically runs the zScan action.

### Step 5 - View app scan results in GitHub

1. Click “Security” on the top navigation bar.
2. Under Security in the left navigation bar, click “Code Scanning” to view all the scan results.

## Adding zScan to an existing workflow

​You must run the action on an ubuntu-latest GitHub Action runner for an existing workflow.  ​If you do not yet have a workflow, you can add a new file called zscan.yml in your .github/workflows folder.
​Review the provided [example](https://github.com/Zimperium/zScanMarketplace/tree/master/workflows).

## If You Run Into Issues

File [issues](https://github.com/Zimperium/zScanMarketplace/issues) for missing content or errors. Explain what you think is missing and give a suggestion as to where it could be added.

## License

This script is licensed under the MIT License. By using this plugin, you agree to the following terms:

    ```text
    MIT License

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    ```

## Enhancements

Submitting improvements to the plugin is welcomed and all pull requests will be approved by Zimperium after review.
