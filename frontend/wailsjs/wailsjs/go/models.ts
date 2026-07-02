export namespace git {
	
	export class GitRef {
	    name: string;
	    refGroup: string;
	    shortName: string;
	
	    static createFrom(source: any = {}) {
	        return new GitRef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.refGroup = source["refGroup"];
	        this.shortName = source["shortName"];
	    }
	}
	export class GraphLineCommit {
	    sha: string;
	    shortSha: string;
	    subject: string;
	    date: string;
	    authorName: string;
	    authorEmail: string;
	    isMerge: boolean;
	    parents: string[];
	    refs: GitRef[];
	
	    static createFrom(source: any = {}) {
	        return new GraphLineCommit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sha = source["sha"];
	        this.shortSha = source["shortSha"];
	        this.subject = source["subject"];
	        this.date = source["date"];
	        this.authorName = source["authorName"];
	        this.authorEmail = source["authorEmail"];
	        this.isMerge = source["isMerge"];
	        this.parents = source["parents"];
	        this.refs = this.convertValues(source["refs"], GitRef);
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
	export class GraphLine {
	    row: number;
	    glyph: string;
	    commit?: GraphLineCommit;
	
	    static createFrom(source: any = {}) {
	        return new GraphLine(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.row = source["row"];
	        this.glyph = source["glyph"];
	        this.commit = this.convertValues(source["commit"], GraphLineCommit);
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
	
	export class GraphRange {
	    from: string;
	    to: string;
	
	    static createFrom(source: any = {}) {
	        return new GraphRange(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.from = source["from"];
	        this.to = source["to"];
	    }
	}
	export class GraphLinesResult {
	    lines: GraphLine[];
	    totalCommits: number;
	    truncated: boolean;
	    range: GraphRange;
	
	    static createFrom(source: any = {}) {
	        return new GraphLinesResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.lines = this.convertValues(source["lines"], GraphLine);
	        this.totalCommits = source["totalCommits"];
	        this.truncated = source["truncated"];
	        this.range = this.convertValues(source["range"], GraphRange);
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

}

export namespace main {
	
	export class UserInfo {
	    giteaUserId: number;
	    login: string;
	    fullName?: string;
	    email?: string;
	    avatarUrl?: string;
	    updatedAt: string;
	
	    static createFrom(source: any = {}) {
	        return new UserInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.giteaUserId = source["giteaUserId"];
	        this.login = source["login"];
	        this.fullName = source["fullName"];
	        this.email = source["email"];
	        this.avatarUrl = source["avatarUrl"];
	        this.updatedAt = source["updatedAt"];
	    }
	}
	export class AccountDTO {
	    id: string;
	    platform: string;
	    giteaUrl: string;
	    username: string;
	    keychainService: string;
	    createdAt: string;
	    userInfo?: UserInfo;
	
	    static createFrom(source: any = {}) {
	        return new AccountDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.platform = source["platform"];
	        this.giteaUrl = source["giteaUrl"];
	        this.username = source["username"];
	        this.keychainService = source["keychainService"];
	        this.createdAt = source["createdAt"];
	        this.userInfo = this.convertValues(source["userInfo"], UserInfo);
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
	export class AddProjectArgs {
	    giteaAccountId: string;
	    owner: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new AddProjectArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.giteaAccountId = source["giteaAccountId"];
	        this.owner = source["owner"];
	        this.name = source["name"];
	    }
	}
	export class AddProjectResult {
	    project: store.RepoProject;
	
	    static createFrom(source: any = {}) {
	        return new AddProjectResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.project = this.convertValues(source["project"], store.RepoProject);
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
	    projectId?: string;
	    platform: string;
	    hostUrl: string;
	    username: string;
	    owner: string;
	    repo: string;
	
	    static createFrom(source: any = {}) {
	        return new CloneRepoArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectId = source["projectId"];
	        this.platform = source["platform"];
	        this.hostUrl = source["hostUrl"];
	        this.username = source["username"];
	        this.owner = source["owner"];
	        this.repo = source["repo"];
	    }
	}
	export class CloneRepoResult {
	    localPath: string;
	    reused: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CloneRepoResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.localPath = source["localPath"];
	        this.reused = source["reused"];
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
	export class FileChangeDTO {
	    filename: string;
	    previousFilename?: string;
	    status: string;
	    additions: number;
	    deletions: number;
	    binary?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FileChangeDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.filename = source["filename"];
	        this.previousFilename = source["previousFilename"];
	        this.status = source["status"];
	        this.additions = source["additions"];
	        this.deletions = source["deletions"];
	        this.binary = source["binary"];
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
	    files?: FileChangeDTO[];
	    additions?: number;
	    deletions?: number;
	    filesChanged?: number;
	
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
	        this.files = this.convertValues(source["files"], FileChangeDTO);
	        this.additions = source["additions"];
	        this.deletions = source["deletions"];
	        this.filesChanged = source["filesChanged"];
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
	export class ConnectArgs {
	    platform: string;
	    giteaUrl: string;
	    token: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.platform = source["platform"];
	        this.giteaUrl = source["giteaUrl"];
	        this.token = source["token"];
	    }
	}
	export class UserDTO {
	    id: number;
	    login: string;
	    fullName?: string;
	    email?: string;
	    avatarUrl?: string;
	
	    static createFrom(source: any = {}) {
	        return new UserDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.login = source["login"];
	        this.fullName = source["fullName"];
	        this.email = source["email"];
	        this.avatarUrl = source["avatarUrl"];
	    }
	}
	export class ConnectResult {
	    account: AccountDTO;
	    user: UserDTO;
	
	    static createFrom(source: any = {}) {
	        return new ConnectResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.account = this.convertValues(source["account"], AccountDTO);
	        this.user = this.convertValues(source["user"], UserDTO);
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
	export class DisconnectArgs {
	    giteaUrl: string;
	
	    static createFrom(source: any = {}) {
	        return new DisconnectArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.giteaUrl = source["giteaUrl"];
	    }
	}
	export class DisconnectOneArgs {
	    giteaUrl: string;
	    username: string;
	
	    static createFrom(source: any = {}) {
	        return new DisconnectOneArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.giteaUrl = source["giteaUrl"];
	        this.username = source["username"];
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
	export class GetGitGraphArgs {
	    projectId: string;
	    branches?: string[];
	    maxCount?: number;
	
	    static createFrom(source: any = {}) {
	        return new GetGitGraphArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectId = source["projectId"];
	        this.branches = source["branches"];
	        this.maxCount = source["maxCount"];
	    }
	}
	export class GetRepoByIdArgs {
	    projectId: string;
	
	    static createFrom(source: any = {}) {
	        return new GetRepoByIdArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectId = source["projectId"];
	    }
	}
	export class GetRepoByIdResult {
	    project: store.RepoProject;
	    account: AccountDTO;
	    localPath: string;
	    cloned: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GetRepoByIdResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.project = this.convertValues(source["project"], store.RepoProject);
	        this.account = this.convertValues(source["account"], AccountDTO);
	        this.localPath = source["localPath"];
	        this.cloned = source["cloned"];
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
	export class GetUserPrefsArgs {
	    keys: string[];
	
	    static createFrom(source: any = {}) {
	        return new GetUserPrefsArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.keys = source["keys"];
	    }
	}
	export class GraphBranchLineDTO {
	    x1: number;
	    y1: number;
	    x2: number;
	    y2: number;
	    lockedFirst: boolean;
	    isCommitted: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GraphBranchLineDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.x1 = source["x1"];
	        this.y1 = source["y1"];
	        this.x2 = source["x2"];
	        this.y2 = source["y2"];
	        this.lockedFirst = source["lockedFirst"];
	        this.isCommitted = source["isCommitted"];
	    }
	}
	export class GraphBranchDTO {
	    color: number;
	    end: number;
	    lines: GraphBranchLineDTO[];
	
	    static createFrom(source: any = {}) {
	        return new GraphBranchDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.color = source["color"];
	        this.end = source["end"];
	        this.lines = this.convertValues(source["lines"], GraphBranchLineDTO);
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
	
	export class GraphEdgeDTO {
	    fromRow: number;
	    toRow: number;
	    fromLane: number;
	    toLane: number;
	    color: number;
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
	        this.color = source["color"];
	        this.type = source["type"];
	    }
	}
	export class GraphNodeDTO {
	    row: number;
	    lane: number;
	    color: number;
	    sha: string;
	    shortSha: string;
	    subject: string;
	    authorName: string;
	    authorEmail: string;
	    date: string;
	    isMerge: boolean;
	    parents: string[];
	    refs?: string[];
	    refTypes?: string[];
	    isCurrent?: boolean;
	    isStash?: boolean;
	    isCommitted: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GraphNodeDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.row = source["row"];
	        this.lane = source["lane"];
	        this.color = source["color"];
	        this.sha = source["sha"];
	        this.shortSha = source["shortSha"];
	        this.subject = source["subject"];
	        this.authorName = source["authorName"];
	        this.authorEmail = source["authorEmail"];
	        this.date = source["date"];
	        this.isMerge = source["isMerge"];
	        this.parents = source["parents"];
	        this.refs = source["refs"];
	        this.refTypes = source["refTypes"];
	        this.isCurrent = source["isCurrent"];
	        this.isStash = source["isStash"];
	        this.isCommitted = source["isCommitted"];
	    }
	}
	export class GraphResultDTO {
	    nodes: GraphNodeDTO[];
	    edges: GraphEdgeDTO[];
	    branches?: GraphBranchDTO[];
	    maxLane: number;
	    truncated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GraphResultDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.nodes = this.convertValues(source["nodes"], GraphNodeDTO);
	        this.edges = this.convertValues(source["edges"], GraphEdgeDTO);
	        this.branches = this.convertValues(source["branches"], GraphBranchDTO);
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
	export class IsRepoClonedArgs {
	    username?: string;
	    owner: string;
	    repo: string;
	
	    static createFrom(source: any = {}) {
	        return new IsRepoClonedArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.username = source["username"];
	        this.owner = source["owner"];
	        this.repo = source["repo"];
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
	export class ListReposArgs {
	    giteaAccountId: string;
	    query?: string;
	    limit: number;
	    page: number;
	
	    static createFrom(source: any = {}) {
	        return new ListReposArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.giteaAccountId = source["giteaAccountId"];
	        this.query = source["query"];
	        this.limit = source["limit"];
	        this.page = source["page"];
	    }
	}
	export class ListReposResp {
	    items: platform.RepoDTO[];
	    total: number;
	    page: number;
	    hasMore: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ListReposResp(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.items = this.convertValues(source["items"], platform.RepoDTO);
	        this.total = source["total"];
	        this.page = source["page"];
	        this.hasMore = source["hasMore"];
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
	export class LogFrontendArgs {
	    level: string;
	    message: string;
	    description?: string;
	    source?: string;
	
	    static createFrom(source: any = {}) {
	        return new LogFrontendArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.level = source["level"];
	        this.message = source["message"];
	        this.description = source["description"];
	        this.source = source["source"];
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
	
	    static createFrom(source: any = {}) {
	        return new PullRepoArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.localPath = source["localPath"];
	    }
	}
	export class PullRepoByProjectIdArgs {
	    projectId: string;
	
	    static createFrom(source: any = {}) {
	        return new PullRepoByProjectIdArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectId = source["projectId"];
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
	export class RemoveProjectArgs {
	    projectId: string;
	
	    static createFrom(source: any = {}) {
	        return new RemoveProjectArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectId = source["projectId"];
	    }
	}
	export class RemoveWorkspaceReposArgs {
	    username: string;
	
	    static createFrom(source: any = {}) {
	        return new RemoveWorkspaceReposArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.username = source["username"];
	    }
	}
	export class RemoveWorkspaceReposResult {
	    removedCount: number;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new RemoveWorkspaceReposResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.removedCount = source["removedCount"];
	        this.message = source["message"];
	    }
	}
	export class SetUserPrefsArgs {
	    entries: Record<string, any>;
	
	    static createFrom(source: any = {}) {
	        return new SetUserPrefsArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.entries = source["entries"];
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
	export class StatusResult {
	    accounts: AccountDTO[];
	    currentUser?: UserDTO;
	
	    static createFrom(source: any = {}) {
	        return new StatusResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.accounts = this.convertValues(source["accounts"], AccountDTO);
	        this.currentUser = this.convertValues(source["currentUser"], UserDTO);
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
	export class SwitchAccountArgs {
	    accountId: string;
	
	    static createFrom(source: any = {}) {
	        return new SwitchAccountArgs(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.accountId = source["accountId"];
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
	
	
	export class WorkspaceInfo {
	    dataRoot: string;
	    workspacePath: string;
	    isDefault: boolean;
	    validated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dataRoot = source["dataRoot"];
	        this.workspacePath = source["workspacePath"];
	        this.isDefault = source["isDefault"];
	        this.validated = source["validated"];
	    }
	}

}

export namespace platform {
	
	export class RepoPermissions {
	    pull: boolean;
	    push: boolean;
	    admin: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RepoPermissions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.pull = source["pull"];
	        this.push = source["push"];
	        this.admin = source["admin"];
	    }
	}
	export class RepoDTO {
	    owner: string;
	    name: string;
	    fullName: string;
	    defaultBranch: string;
	    description?: string;
	    private: boolean;
	    id: number;
	    archived: boolean;
	    updatedAt: string;
	    permissions?: RepoPermissions;
	    projectId?: string;
	    isProject: boolean;
	    lastSyncAt?: string;
	
	    static createFrom(source: any = {}) {
	        return new RepoDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.owner = source["owner"];
	        this.name = source["name"];
	        this.fullName = source["fullName"];
	        this.defaultBranch = source["defaultBranch"];
	        this.description = source["description"];
	        this.private = source["private"];
	        this.id = source["id"];
	        this.archived = source["archived"];
	        this.updatedAt = source["updatedAt"];
	        this.permissions = this.convertValues(source["permissions"], RepoPermissions);
	        this.projectId = source["projectId"];
	        this.isProject = source["isProject"];
	        this.lastSyncAt = source["lastSyncAt"];
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

}

export namespace store {
	
	export class RepoProject {
	    id: string;
	    platform: string;
	    accountId: string;
	    owner: string;
	    name: string;
	    defaultBranch: string;
	    lastSyncAt: number;
	    createdAt: number;
	
	    static createFrom(source: any = {}) {
	        return new RepoProject(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.platform = source["platform"];
	        this.accountId = source["accountId"];
	        this.owner = source["owner"];
	        this.name = source["name"];
	        this.defaultBranch = source["defaultBranch"];
	        this.lastSyncAt = source["lastSyncAt"];
	        this.createdAt = source["createdAt"];
	    }
	}

}

