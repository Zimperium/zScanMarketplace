# `zimperium-zscan`

The `zimperium-zscan` scans your mobile app binary (ios or android) and identifies the security, privacy, and compliance-related vulnerabilities.

**Features**:

- Identify risks and provide recommendations to mitigate the risk
- Highlights the vulnerable code snippet
- Lists the locations where the vulnerable code snippet was found
- Integrates with GitHub Advanced Security (GHAS) to display issues and remediation information inside of GitHub code scanning alerts
- Run scans for each merge or pull request

### Prerequisites

- To use this action an active Zimperium zSCAN account is required. If you are not an existing Zimperium zSCAN customer, please email krishna.vishnubhotla@zimperium.com for a free trial of this feature.
- Requires either [GitHub Advanced Security](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security) (GHAS) or a public repository in order to display issues and remediation information inside of GitHub code scanning alerts.

### GitHub Marketplace Setup (recommended)

Click the "Security" tab in your repository (GHAS must be enabled) then "Set up code scanning" then select the zScan action from the marketplace and follow the listed instructions.

### Setting up this Action

- First, generate your Zimperium zScan platform token. 
  - To generate a token, in the UI, go to the < page name >  page and click “Create Token”
- Then, In the repository settings, set up a new ZSCAN_CLIENT_SECRET token by clicking "Secrets" and then "New repository secret"
- Next, copy the CLIENT_ID for the group you would like to pull from
  - To find your CLIENT_ID, in the UI, go to your app’s < page name > page and copy the CLIENT_ID by < insert action to find id >
- Lastly, enable scanning alerts in GitHub. 
  - Click the "Security" tab in your repository (GHAS must be enabled) then "Set up code scanning" then select the zScan action from the marketplace and follow the listed instructions.

### Required Configuration

For an _existing_ workflow,

The action must be run on an `ubuntu-latest` GitHub Action runner.

After the application build step run the zScan action and upload the SARIF to GHAS:

```yml
    - name: Zimperium
      uses: zimperium/zscanmarketplace@v1
      timeout-minutes: 60
      with:
        client_env: $CLIENT_ENV                              # REPLACE: Zimperium Environment Name
        client_id: $CLIENT_ID				                 # REPLACE: Zimperium Client ID
        client_secret: ${{ secrets.ZSCAN_CLIENT_SECRET }}
        app_file: ${{ steps.apk-path.outputs.path }}		 # REPLACE: The path to an .ipa or .apk

    - name: Upload SARIF file
      uses: github/codeql-action/upload-sarif@v1
      with:
        path: zScan.sarif
```

Add a new file called `zscan.yml` in your `.github/workflows` folder and review the [example](https://github.com/Zimperium/zScanMarketplace/blob/master/workflows/zScanAction.yml).

## License

This project is released under the [MIT License](https://github.com/Zimperium/zScanMarketplace/blob/master/LICENSE).

Zimperium zScan Platform, used in this action, has separate [Terms and Conditions](https://www.zimperium.com/zimperium-eula/) and requires a valid license to function.