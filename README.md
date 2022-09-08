# `zimperium-zscan`
​
The `zimperium-zscan` action scans your mobile app binary (iOS or Android) and identifies security, privacy, and compliance-related vulnerabilities.
​
### Features
​
The features for this action include:
​
- Identifies the risks and provides recommendations to mitigate the risks.
- Highlights the vulnerable code snippet.
- Lists the locations where you can find the vulnerable code snippet.
- Integrates with GitHub Advanced Security (GHAS) to display issues and remediation information inside of GitHub code scanning alerts.
- Run scans for each merge or pull request.
​
### Prerequisites
​
The prerequisites include the following:
​
- An active Zimperium zScan account is required. If you are not an existing Zimperium zScan customer, please email krishna.vishnubhotla@zimperium.com for a free trial of this feature.
- Either [GitHub Advanced Security](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security) (GHAS) or a public repository is required to display issues and view the remediation information inside of GitHub code scanning alerts.
​
### GitHub Marketplace Setup (Recommended)
​
Click the **Security** tab in your repository (GHAS must be enabled) and then **Set up code scanning**. Then select the zScan action from the marketplace and follow the listed instructions.
​
### Setting Up This Action
​
Perform the following steps to set up this action.
​
1. Generate your Zimperium zScan platform authorization API key, which is a client ID and secret.
​
    - Log in to the zConsole user interface zScan platform. 
    - Click the **Account Management** gear icon in the upper-right.
    - Click the **Authorizations** menu item.
    - Click the **+ Generate API Key** button.
    - Enter a description and select the zScan needed permissions and click the **Save API Access** button.
    - Store the client ID (CLIENT_ID) and the client secret (ZSCAN_CLIENT_SECRET) values. 
​
2. In the repository settings, set up a new ZSCAN_CLIENT_SECRET key by clicking **Secrets** and then **New repository secret**.
3. Next, copy the CLIENT_ID for the group from which you would like to pull.
​
    - Your CLIENT_ID, in the user interface, go to your app’s < page name > page and copy the CLIENT_ID by < insert action to find id >.
​
4. Lastly, enable scanning alerts in GitHub. 
​
    - Click the **Security** tab in your repository (GHAS must be enabled), and then **Set up code scanning**.
    - Select the zScan action from the marketplace and follow the listed instructions.
​
### Required Configuration
​
For an existing workflow, the action must be run on an `ubuntu-latest` GitHub Action runner.

After the application build step, run the zScan action and upload the SARIF to GHAS:
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
​
Add a new file called `zscan.yml` in your `.github/workflows` folder and review the [example](https://github.com/Zimperium/zScanMarketplace/blob/master/workflows/zScanAction.yml).
​
## License
​
This project is released under the [MIT License](https://github.com/Zimperium/zScanMarketplace/blob/master/LICENSE).

The Zimperium zScan Platform, used in this action, has separate [Terms and Conditions](https://www.zimperium.com/zimperium-eula/) and requires a valid license to function.