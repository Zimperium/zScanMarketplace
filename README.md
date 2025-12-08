# Zimperium zScan GitHub Action

## Mobile Application Security Testing

The zimperium-zscan action scans your mobile app binary (ios or android) and identifies the security, privacy, and compliance-related vulnerabilities.

## Features

    - Identify risks and provide recommendations to mitigate the risk
    - Highlights the vulnerable code snippet
    - Lists the locations where the vulnerable code snippet was found
    - Integrates with GitHub Advanced Security (GHAS) to display issues and remediation information inside of GitHub code scanning alerts
    - Run scans for each merge or pull request

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

    - name: Upload SARIF file
        uses: github/codeql-action/upload-sarif@v4
        with:  
            sarif_file: Sample_Insecure_Bank_App_zscan.sarif
    ```

## GitHub Prerequisites

- If you use an Enterprise GitHub account, you need a GitHub Advanced Security (GHAS) license to import zScan results into your repository's Security Dashboard.  Alternatively, you can skip uploading the SARIF file.
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
