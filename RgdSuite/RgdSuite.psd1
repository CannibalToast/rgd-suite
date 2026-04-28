@{
    RootModule           = 'RgdSuite.psm1'
    ModuleVersion      = '1.1.1'
    GUID               = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    Author             = 'CannibalToast'
    CompanyName        = 'CannibalToast'
    Copyright          = '(c) CannibalToast. All rights reserved.'
    Description        = 'PowerShell wrapper for the RGD Suite VS Code extension CLI — convert, edit, and validate Relic Game Data files from the terminal.'
    PowerShellVersion  = '5.1'
    FunctionsToExport  = @(
        'ConvertTo-RgdText', 'ConvertFrom-RgdText',
        'ConvertTo-RgdLua',  'ConvertFrom-RgdLua',
        'Get-RgdInfo', 'Get-RgdHash',
        'Expand-RgdSga',
        'Invoke-RgdBatchToLua', 'Invoke-RgdBatchToRgd'
    )
    AliasesToExport    = @(
        'rgd-toText', 'rgd-fromText',
        'rgd-toLua',  'rgd-fromLua',
        'rgd-info',   'rgd-hash',
        'rgd-extract','rgd-batchLua',
        'rgd-batchRgd'
    )
    PrivateData        = @{
        PSData = @{
            Tags         = @('RGD', 'DawnOfWar', 'CompanyOfHeroes', 'Modding', 'Relic')
            LicenseUri   = 'https://github.com/CannibalToast/rgd-suite/blob/main/LICENSE'
            ProjectUri   = 'https://github.com/CannibalToast/rgd-suite'
            ReleaseNotes = 'Initial PowerShell module release with full CLI coverage.'
        }
    }
}
