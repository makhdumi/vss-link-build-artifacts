import * as tl from 'vsts-task-lib/task';
import { IBuildApi } from 'vso-node-api/BuildApi';
import { IRequestHandler } from 'vso-node-api/interfaces/common/VsoBaseInterfaces';
import { ArtifactResource } from 'vso-node-api/interfaces/BuildInterfaces';
import { WebApi, getPersonalAccessTokenHandler, getHandlerFromToken } from 'vso-node-api/WebApi';

import trm = require('vsts-task-lib/toolrunner');
import fse = require('fs-extra');
import path = require('path');
import process = require('process');

var cachedSmbSharePaths = {}

function getSymbShareFolderSync(shareName: string, logId: string) {
    var cacheKey = shareName.toLowerCase();
    if (!cachedSmbSharePaths[cacheKey]) {
        tl.debug(`${logId}Looking up SMB mapping for share ${shareName}`)
        var tool = tl.tool(tl.which("powershell")).arg(`get-smbshare '${shareName}' | % path`);
        var result = tool.execSync();
        if (result.error) throw(result.error);
        
        cachedSmbSharePaths[cacheKey] = result.stdout.trim();
    } else {
        tl.debug(`${logId}Found mapping for share name ${shareName} in cache`);      
    }

    return cachedSmbSharePaths[cacheKey];
}

async function resolveSmbPath(filePath: string, logId: string) {
    var match = /^\\\\(.+?)\\(.+?)\\(.*)$/.exec(filePath);
    if (!match) return filePath;

    tl.debug(`${logId}Resolving SMB path ${filePath}'`);

    var host = match[1].toLowerCase();
    var machineName = process.env["computername"];
    if (host != "localhost" && host != "127.0.0.1" &&
        (machineName && host != machineName.toLowerCase())) {
        throw Error(`SMB path ${filePath} is not on localhost`);
    }

    var shareName = match[2];
    var subPath = match[3];

    var resolvedRoot = getSymbShareFolderSync(shareName, logId);
    return path.join(resolvedRoot, subPath);
}

async function makeLink(filePath: string, destDir: string, destName: string, hardLinks: boolean, logId: string) {
    var localPath = await resolveSmbPath(filePath, logId);
    tl.debug(`${logId}Resolved '${filePath}' to '${localPath}'`);

    if (await fse.exists(localPath) == false) {
        throw Error(`${localPath} does not exist`)
    }

    var destPath = path.join(destDir, destName);
    await fse.mkdirs(path.dirname(destPath));

    var alreadyExists = await fse.exists(destPath);
    if (alreadyExists) {
        console.log(`Deleting existing ${destPath}`)
        await fse.unlink(destPath);
    }

    var pathInfo = await fse.lstat(localPath);
    if (pathInfo.isDirectory()) {

        if (!hardLinks) {
            console.log(`${logId}Creating symbolic link from ${localPath} to ${destPath}`);
            // NTFS exclusive "junction" here gets ignored on non-Windows platforms
            await fse.symlink(localPath, destPath, "junction");
        } else {
            var childFiles = await fse.readdir(localPath);
            for (var i = 0; i < childFiles.length; i++) {
                var childLocalPath = path.join(localPath, childFiles[i]);
                await makeLink(childLocalPath, destPath, childFiles[i], hardLinks, logId);
            }
        }
    } else {
        console.log(`${logId}Creating hard link from ${localPath} to ${destPath}`);
        await fse.link(localPath, destPath);
    }
}

async function run() {
    try {
        var projectId: string = tl.getVariable("System.TeamProject") 
        var buildId: number = parseInt(tl.getVariable("Build.BuildId"));
        var endpointUrl: string = tl.getVariable("System.TeamFoundationCollectionUri");

        var destinationDir: string = tl.getInput("destinationDir") || tl.getVariable("System.ArtifactsDirectory");

        var hardLinksOnlyStr: string = tl.getInput("hardLinksOnly");
        var hardLinksOnly: boolean = hardLinksOnlyStr ? hardLinksOnlyStr.toLocaleLowerCase() == 'true' : false;

        var cleanDestinationDirStr: string = tl.getInput("cleanDestinationDir");
        var cleanDestinationDir: boolean = cleanDestinationDirStr ? cleanDestinationDirStr.toLocaleLowerCase() == 'true' : false;

        var artifactNameRegexStr: string = tl.getInput("artifactNameRegex");
        var artifactNameRegex: RegExp = artifactNameRegexStr ? new RegExp(artifactNameRegexStr, "i") : null;

        var pat: string = tl.getVariable("SYSTEM_VSTSPAT");
        var accessToken: string = tl.getEndpointAuthorizationParameter('SYSTEMVSSCONNECTION', 'AccessToken', !!pat);
        let credentialHandler: IRequestHandler = pat ? getPersonalAccessTokenHandler(pat) : getHandlerFromToken(accessToken);
        var webApi: WebApi = new WebApi(endpointUrl, credentialHandler);

        var buildApi: IBuildApi = webApi.getBuildApi();
        var artifacts = await buildApi.getArtifacts(buildId, projectId);

        if (cleanDestinationDir) {
            console.log(`Emptying ${destinationDir}`);
            await fse.emptyDir(destinationDir);
        }

        var makeLinkPromises = Array(artifacts.length);
        for (var i = 0; i < artifacts.length; i++) {
            var res: ArtifactResource = artifacts[i].resource
            console.log(`Processing artifact: ${artifacts[i].name}`);
            if (artifacts[i].resource.type != "filepath") {
                console.log(`Skipping ${artifacts[i]} because it is not a file share artifact`);
                continue;
            }

            if (artifactNameRegex && !artifactNameRegex.exec(artifacts[i].name)) {
                console.log(`Skipping ${artifacts[i].name} because it doesn't match regex ${artifactNameRegex}`);
                continue;
            }

            console.log(`Linking build artifact ${artifacts[i].name}`);
            var fullPath = path.join(artifacts[i].resource.data, artifacts[i].name);
            makeLinkPromises[i] = makeLink(fullPath, destinationDir, artifacts[i].name, hardLinksOnly, artifacts[i].name + "> ");
        }
        await Promise.all(makeLinkPromises);

    } catch(err) {
        tl.setResult(tl.TaskResult.Failed, err.message);
        console.log(err);
    }

}

run();