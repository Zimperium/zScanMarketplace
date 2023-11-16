# Zimperium zSCAN 
## Mobile Application Security Testing

The zimperium-zscan action scans your mobile app binary (ios or android) and identifies the security, privacy, and compliance-related vulnerabilities.

## Features:
    - Identify risks and provide recommendations to mitigate the risk
    - Highlights the vulnerable code snippet
    - Lists the locations where the vulnerable code snippet was found
    - Integrates with GitHub Advanced Security (GHAS) to display issues and remediation information inside of GitHub code scanning alerts
    - Run scans for each merge or pull request

## GitHub Prerequisites
  - If you use an Enterprise GitHub account, you need a GitHub Advanced Security (GHAS) license to use the zScan Action.
  - If you are using a Public repository, GHAS, and Code Scanning are already enabled for you by default. 

## Get Started 

### Step 1 - Get API Keys 
 - **If you are an existing Zimperium zSCAN Customer**
    - 1. Log in to the zConsole user interface zScan platform.
    - 2. Click the Account Management gear icon.
    - 4. Click the Authorizations menu item.
    - 5. Click the + Generate API Key button.
    - 6. Enter a description and select the zScan needed permissions at the bottom. Select View for all permissions except for zScan Builds and click Upload for it.
    - 7. Click the Save API Access button.
    - 8. Click the copy icons and store both the client ID (CLIENT_ID) and the client secret (ZSCAN_CLIENT_SECRET) values.
    - 9. Click Close.​
     
- **If you want to enroll in our 30 Day FREE TRIAL**

    - 1. Registration - Please fill out this [form](https://get.zimperium.com/github-action-zscan/) to register for the free trial.
    - 2. Post Registration 
        - **API Secret Key** - Once you submit the registration form, an API Key will be immediately displayed. This is your ZSCAN_CLIENT_SECRET. PLEASE SAVE THIS KEY.
        - **API CLIENT ID** - A second key will be sent to the email address you provided during registration. This is your CLIENT_ID.
To set up the action, you need both keys.

- **If I misplace or forget my keys, what should I do?**

    - Resubmit the registration form with the same email address. This will not restart the trial, but it will provide you with new trial keys.
      
- **If I need assistance, what should I do?**
    - Send an email to krishna.vishnubhotla@zimperium.com with the details. The subject of the email should be "GitHub zScan Action Free Trail".

### Step 2 - Enable GHAS in GitHub

You need to enable GHAS to display issues and remediation information inside of GitHub code scanning alerts.  Once you acquire the GHAS license, follow the instructions below to enable GHAS.
1. Click the Settings tab in your GitHub repository.
2. Click Code Security and Analysis on the left navigation pane under the Security section.
3. Click Enable for GitHub Advanced Security and confirm the setting. This permits code scanning and secret scanning.
4. Under GHAS, ensure that Set up code scanning is enabled. This is a required step.


### Step 3 - Add a Repository Secret in GitHub
The secret is being added so that you can use it in the zScan workflow next. Follow the instructions below to add a secret.
1. Under Security, select “Secrets and Variables” and then Actions.
2. Click the “New repository secret” button.
3. Enter the Name field for the secret as ZSCAN_CLIENT_SECRET.
4. Enter the API Secret Key you obtained from Step 1
5. Click Add secret.

### Step 4 - Add and Configure zSCAN Workflow in GitHub
1. Click the "Security" tab in your repository (GHAS must be enabled).
2. Click "Set up code scanning" under “Vulnerability Alert” on the left navigation pane.
3. Click “Configure Scanning Tool”.
4. Under the Code Scanning section, click “Explore Workflows”.
5. Enter “zScan” in the search box and hit enter.
6. The zScan action is displayed. Click the “Configure” button.
7. The zScan.yml file will automatically be opened.
8. Click the Edit button and make the following changes in the zscan.yml file.
9. Change the value for client_env.
    - If you are a FREE TRIAL USER, then make sure the line reads “client_env: mapsfreemium”.
    - If you are a zScan customer, please review the zScan user guide for the right value. 
    - Please Note: The two spaces after “:” are MANDATORY.
10. Change the value for client_id.
    - Where it says “client_id: CNm4gbdCRIyIkv-yjUZ0_K”, change “CNm4gbdCRIyIkv-yjUZ0_K” with the CLIENT_ID from Step 1.
11. Change the value for app_file.
    - Change the value to the location of the .ipa or .apk files you want to submit to zScan.
    - If the file is the main repository folder then you can change the value to “app_file: ./<appfilename>”. A good example would be "app_file: ./InsecureBankv2.apk".
12. Click “Commit changes”,choose “Commit directly to the main branch.” and commit the changes.
13. Committing the changes automatically runs the zscan action. 

### Step 5 - View app scan results in GitHub
1. Click “Security” on the top navigation bar.
2. Under Security in the left navigation bar, click “Code Scanning” to view all the scan results.

### Adding zScan to an existing worklow
​You must run the action on an ubuntu-latest GitHub Action runner for an existing workflow.  ​If you do not yet have a workflow, you can add a new file called zscan.yml in your .github/workflows folder.  ​Review the example at this location https://github.com/Zimperium/zScanMarketplace/blob/master/workflows/zScanAction.yml.​​ 

### Ready To Purchase zSCAN
Click [here](https://get.zimperium.com/purchase-zscan/) to start the process and get some promotional pricing.

### License
This project is released under the [MIT License](https://github.com/Zimperium/zScanMarketplace/blob/master/LICENSE).
Zimperium zScan Platform, used in this action, has separate [Terms and Conditions](https://www.zimperium.com/zimperium-eula/) and requires a valid license to function.

