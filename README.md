# `zimperium-zscan`
​
Scan your mobile app binaries and identify security, privacy, and compliance-related vulnerabilities. Free Trial Available.
​
## Features
​
The features for this action include:
​
- Identifies the risks and provides recommendations to mitigate the risks.
- Highlights the vulnerable code snippet.
- Lists the locations where you can find the vulnerable code snippet.
- Integrates with GitHub Advanced Security (GHAS) to display issues and remediation information inside of GitHub code scanning alerts.
- Run scans for each merge or pull request.
​
## Prerequisites
​
The prerequisites include the following:
​
- An active Zimperium zScan account is required. If you are not an existing Zimperium zScan customer, please request a zSCAN demo by clicking [here](https://www.zimperium.com/contact-us).
- Either [GitHub Advanced Security](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security) (GHAS) or a public repository is required to display issues and view the remediation information inside of GitHub code scanning alerts.
​
## GitHub Marketplace Setup (Recommended)
​
You must ensure that you enable GHAS along with code scanning. You select the zScan action from the marketplace and configure your workflow to include the scanning steps. Follow the next section's steps to ensure they are set up.  
​
## Setting Up This Action
​
Perform the following steps to set up this action:
​
1. Generate your Zimperium zScan authorization API key, which is a client ID and secret.
​
    - Log in to the zConsole user interface zScan platform. 
    - Click the **Account Management** gear icon.
    - Click the **Authorizations** menu item.
    - Click the **+ Generate API Key** button.
    - Enter a description and select the zScan needed permissions at the bottom. Select **View** for all permissions except for **zScan Builds** and click **Upload** for it.
    - Click the **Save API Access** button.
    - Click the copy icons and store both the client ID (CLIENT_ID) and the client secret (ZSCAN_CLIENT_SECRET) values. 
    - Click **Close**.
​
2. In the GitHub repository settings, enable GitHub Advanced Security and set up a new secret.
​
    - Click the **Settings** tab in your GitHub repository.
    - Click **Code security and analysis**, then click **Enable** for **GitHub Advanced Security** and confirm the setting. This permits code scanning and secret scanning.
    - Under GHAS, ensure that **Set up code scanning** is enabled. This is a required step.
    - Then add the secret key.
        - Under **Security**, select **Secrets** and then **Actions**.
        - Click the **New repository secret** button.
        - Enter the **Name** field for the secret as **ZSCAN_CLIENT_SECRET**.
        - Enter the **Secret** field with the value you paste from Step 1 above, where you stored the secret.
        - Click **Add secret**.
         
3. Set the values in the YML file for the workflow.
​
    - See the **Required Configuration** section below for the actual link of the YML file text and a snippet example to add to an existing workflow.  
    - If your repository has an existing workflow, you can add those steps to your existing YML file. Or, you add it as a new file to your repository under the directory of `.github/workflows`. The filename can be any name, such as `zscan.yml`.
    - You must change two things in the YML file:
        - The `client_env` value needs to change to your subdomain value in your zConsole login URL. For instance, for `https://ziap.zimperium.com/login`, the client environment value is `ziap`.
        - The `client_id` value also needs to change. Paste from Step 1 above the value you stored for the client ID.
    - For the path item in the example YML file, the `steps.apk-path.outputs.path` is a calculated field, and you do not need to set it in the file. However, you can set this value to a hard-coded location if needed.
    - Once you commit this workflow to the master branch, it triggers a run for each commit to master after you complete the setup steps.
​
## Viewing the Action Findings
​
Perform the following steps to view the output of this action:
​
1. View the logs from each workflow run.
​
    - Within your GitHub repository, click the **Actions** tab.
    - Select the desired workflow run.
    - Click the **scan** section to view the log messages.
    - Expand the **Zimperium** steps to see the log messages. Any errors found in the scanning display here.
​
2. View the findings from each workflow run.
​
    - Within your GitHub repository, click the **Security** tab. 
    - Click on **Code scanning**, and each finding is listed here.
    - You can drill further into the details by clicking on each finding, and you can view:
        - Recommendations
        - Code Snippets
        - General Descriptions
        - Business Impacts
​
​
## Required Configuration
​
You must run the action on an `ubuntu-latest` GitHub Action runner for an existing workflow. 
​
After the application build step, run the zScan action and upload the SARIF to GHAS.
​
If you do not yet have a workflow, you can add a new file called `zscan.yml` in your `.github/workflows` folder.
​
Review the example at this location [https://github.com/Zimperium/zScanMarketplace/blob/master/workflows/zScanAction.yml](https://github.com/Zimperium/zScanMarketplace/blob/master/workflows/zScanAction.yml).​
​
This is a sample snippet from the above YML link:
​
```yml
    - name: Zimperium
      uses: zimperium/zscanmarketplace@v1
      timeout-minutes: 60
      with:
        client_env: $CLIENT_ENV                           # REPLACE: Zimperium Environment Name
        client_id: $CLIENT_ID                             # REPLACE: Zimperium Client ID
        client_secret: ${{ secrets.ZSCAN_CLIENT_SECRET }} 
        app_file: ${{ steps.apk-path.outputs.path }}      # REPLACE: The path to an .ipa or .apk
​
    - name: Upload SARIF file
      uses: github/codeql-action/upload-sarif@v1
      with:
        path: zScan.sarif
```
​​
## License
​
This project is released under the [MIT License](https://github.com/Zimperium/zScanMarketplace/blob/master/LICENSE).
​
The Zimperium zScan Platform, used in this action, has separate [Terms and Conditions](https://www.zimperium.com/zimperium-eula/) and requires a valid license.
