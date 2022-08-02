# `zscan-action`

The `zscan-action` delivers desc1, desc2, desc3 security analysis of iOS and Android apps coded in any language.

**Features**:

- Feature 1
- Feature 2
- Feature 3

### Prerequisites

- To use this action an active < account type > account is required. If you ***are not*** an existing Zimperium Platform customer, please [contact us](<contact url>).
- An active GitHub account (cloud or on-prem) with an active Advanced Security feature

### GitHub Marketplace Setup (recommended)

Click the "Security" tab in your repository (GHAS must be enabled) then "Set up code scanning" then select the zScan action from the marketplace and follow the listed instructions.

### Setting up this Action

- < Detailed steps to get token and so forth >

### Required Configuration

For an _existing_ workflow,

The action must be run on an `ubuntu-latest` GitHub Action runner.

> Note: < Note any dependencies for the project >

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

### Custom Configuration (Optional)

Related Info Block

```yml
code block
```

For a _new_ workflow,

Add a new file called `zscan.yml` in your `.github/workflows` folder and review the [example](<insert example url>).

## License

This project is released under the [<license type>](<insert url>).

zScan Platform, used in this action, has separate [Terms and Conditions](<insert url>) and requires a valid license to function.