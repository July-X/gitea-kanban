export namespace main {
	
	export class AppInfo {
	    version: string;
	    dataDir: string;
	    platform: string;
	
	    static createFrom(source: any = {}) {
	        return new AppInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.dataDir = source["dataDir"];
	        this.platform = source["platform"];
	    }
	}
	export class BranchDTO {
	    name: string;
	    commitSha: string;
	    isProtected: boolean;
	
	    static createFrom(source: any = {}) {
	        return new BranchDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.commitSha = source["commitSha"];
	        this.isProtected = source["isProtected"];
	    }
	}
	export class CloneRepoArgs {
	    platform: string;
	    hostUrl: string;
	    username: string;
	    token: string;
	    owner: string;
	    repo: string;
	    workspacePath: string;
	
	    static createFrom(source: any = {}) {
	        return new CloneRepoArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.platform = source["platform"];
	        this.hostUrl = source["hostUrl"];
	        this.username = source["username"];
	        this.token = source["token"];
	        this.owner = source["owner"];
	        this.repo = source["repo"];
	        this.workspacePath = source["workspacePath"];
	    }
	}
	export class CloneRepoResult {
	    localPath: string;
	
	    static createFrom(source: any = {}) {
	        return new CloneRepoResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.localPath = source["localPath"];
	    }
	}
	export class ColumnDTO {
	    id: string;
	    projectId: string;
	    title: string;
	    position: number;
	    wipLimit?: number;
	
	    static createFrom(source: any = {}) {
	        return new ColumnDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.projectId = source["projectId"];
	        this.title = source["title"];
	        this.position = source["position"];
	        this.wipLimit = source["wipLimit"];
	    }
	}
	export class CommitDetailDTO {
	    sha: string;
	    shortSha: string;
	    subject: string;
	    authorName: string;
	    authorEmail: string;
	    authorWhen: string;
	    message: string;
	    parents: string[];
	
	    static createFrom(source: any = {}) {
	        return new CommitDetailDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sha = source["sha"];
	        this.shortSha = source["shortSha"];
	        this.subject = source["subject"];
	        this.authorName = source["authorName"];
	        this.authorEmail = source["authorEmail"];
	        this.authorWhen = source["authorWhen"];
	        this.message = source["message"];
	        this.parents = source["parents"];
	    }
	}
	export class CreateColumnArgs {
	    projectId: string;
	    title: string;
	    position: number;
	
	    static createFrom(source: any = {}) {
	        return new CreateColumnArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectId = source["projectId"];
	        this.title = source["title"];
	        this.position = source["position"];
	    }
	}
	export class DeleteColumnArgs {
	    columnId: string;
	
	    static createFrom(source: any = {}) {
	        return new DeleteColumnArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columnId = source["columnId"];
	    }
	}
	export class FetchRepoResultDTO {
	    updated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FetchRepoResultDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.updated = source["updated"];
	    }
	}
	export class GetCommitDetailArgs {
	    localPath: string;
	    sha: string;
	
	    static createFrom(source: any = {}) {
	        return new GetCommitDetailArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.localPath = source["localPath"];
	        this.sha = source["sha"];
	    }
	}
	export class GraphEdgeDTO {
	    fromRow: number;
	    toRow: number;
	    fromLane: number;
	    toLane: number;
	    type: number;
	
	    static createFrom(source: any = {}) {
	        return new GraphEdgeDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fromRow = source["fromRow"];
	        this.toRow = source["toRow"];
	        this.fromLane = source["fromLane"];
	        this.toLane = source["toLane"];
	        this.type = source["type"];
	    }
	}
	export class GraphNodeDTO {
	    row: number;
	    lane: number;
	    sha: string;
	    shortSha: string;
	    subject: string;
	    authorName: string;
	    authorEmail: string;
	    date: string;
	    isMerge: boolean;
	    parents: string[];
	
	    static createFrom(source: any = {}) {
	        return new GraphNodeDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.row = source["row"];
	        this.lane = source["lane"];
	        this.sha = source["sha"];
	        this.shortSha = source["shortSha"];
	        this.subject = source["subject"];
	        this.authorName = source["authorName"];
	        this.authorEmail = source["authorEmail"];
	        this.date = source["date"];
	        this.isMerge = source["isMerge"];
	        this.parents = source["parents"];
	    }
	}
	export class GraphResultDTO {
	    nodes: GraphNodeDTO[];
	    edges: GraphEdgeDTO[];
	    maxLane: number;
	    truncated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GraphResultDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.nodes = this.convertValues(source["nodes"], GraphNodeDTO);
	        this.edges = this.convertValues(source["edges"], GraphEdgeDTO);
	        this.maxLane = source["maxLane"];
	        this.truncated = source["truncated"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class IssueDTO {
	    index: number;
	    title: string;
	    state: string;
	    body?: string;
	    author: string;
	
	    static createFrom(source: any = {}) {
	        return new IssueDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.title = source["title"];
	        this.state = source["state"];
	        this.body = source["body"];
	        this.author = source["author"];
	    }
	}
	export class ListBranchesArgs {
	    platform: string;
	    hostUrl: string;
	    username: string;
	    token: string;
	    owner: string;
	    repo: string;
	
	    static createFrom(source: any = {}) {
	        return new ListBranchesArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.platform = source["platform"];
	        this.hostUrl = source["hostUrl"];
	        this.username = source["username"];
	        this.token = source["token"];
	        this.owner = source["owner"];
	        this.repo = source["repo"];
	    }
	}
	export class ListColumnsArgs {
	    projectId: string;
	
	    static createFrom(source: any = {}) {
	        return new ListColumnsArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectId = source["projectId"];
	    }
	}
	export class ListIssuesArgs {
	    platform: string;
	    hostUrl: string;
	    username: string;
	    token: string;
	    owner: string;
	    repo: string;
	    state: string;
	
	    static createFrom(source: any = {}) {
	        return new ListIssuesArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.platform = source["platform"];
	        this.hostUrl = source["hostUrl"];
	        this.username = source["username"];
	        this.token = source["token"];
	        this.owner = source["owner"];
	        this.repo = source["repo"];
	        this.state = source["state"];
	    }
	}
	export class ListStarredBranchesArgs {
	    projectId: string;
	
	    static createFrom(source: any = {}) {
	        return new ListStarredBranchesArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectId = source["projectId"];
	    }
	}
	export class LogGraphArgs {
	    platform: string;
	    localPath: string;
	    branches: string[];
	    maxCount: number;
	
	    static createFrom(source: any = {}) {
	        return new LogGraphArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.platform = source["platform"];
	        this.localPath = source["localPath"];
	        this.branches = source["branches"];
	        this.maxCount = source["maxCount"];
	    }
	}
	export class PullRepoArgs {
	    localPath: string;
	    token: string;
	    username: string;
	
	    static createFrom(source: any = {}) {
	        return new PullRepoArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.localPath = source["localPath"];
	        this.token = source["token"];
	        this.username = source["username"];
	    }
	}
	export class PullRepoResult {
	    beforeCount: number;
	    afterCount: number;
	    addedCommits: number;
	    headBefore: string;
	    headAfter: string;
	    headChanged: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PullRepoResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.beforeCount = source["beforeCount"];
	        this.afterCount = source["afterCount"];
	        this.addedCommits = source["addedCommits"];
	        this.headBefore = source["headBefore"];
	        this.headAfter = source["headAfter"];
	        this.headChanged = source["headChanged"];
	    }
	}
	export class SetWorkspaceArgs {
	    cwd: string;
	
	    static createFrom(source: any = {}) {
	        return new SetWorkspaceArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cwd = source["cwd"];
	    }
	}
	export class StarBranchArgs {
	    projectId: string;
	    branch: string;
	
	    static createFrom(source: any = {}) {
	        return new StarBranchArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectId = source["projectId"];
	        this.branch = source["branch"];
	    }
	}
	export class UnstarBranchArgs {
	    projectId: string;
	    branch: string;
	
	    static createFrom(source: any = {}) {
	        return new UnstarBranchArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectId = source["projectId"];
	        this.branch = source["branch"];
	    }
	}

}

