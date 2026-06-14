/**
 * localStore 业务接口单元测试
 *
 * 覆盖：
 * 1. accounts.ts —— list/findById/findByUrlAndUsername/getFirst
 * 2. projects.ts —— listByAccount/find/findById/findByOwnerName
 * 3. columns.ts —— listByProject/maxPosition/findById/projectExists/idsByProject
 * 4. label-maps.ts —— listByColumn/findByProjectAndLabel/findByColumnAndLabel
 * 5. starred-branches.ts —— listByProject
 *
 * 不引 electron / better-sqlite3；只测纯函数
 */

import { describe, it, expect } from 'vitest';
import {
  listAccountsWithStore,
  findAccountByIdWithStore,
  findAccountByUrlAndUsernameWithStore,
  getFirstAccountWithStore,
} from '../accounts.js';
import {
  listProjectsByAccountWithStore,
  findProjectWithStore,
  findProjectByIdWithStore,
  findProjectsByOwnerNameWithStore,
} from '../projects.js';
import {
  listColumnsByProjectWithStore,
  maxColumnPositionByProjectWithStore,
  findColumnByIdWithStore,
  projectExistsInColumnsWithStore,
  columnIdsByProjectWithStore,
} from '../columns.js';
import {
  listLabelMapsByColumnWithStore,
  findLabelMapByProjectAndLabelWithStore,
  findLabelMapByColumnAndLabelWithStore,
} from '../label-maps.js';
import { listStarredBranchesWithStore } from '../starred-branches.js';
import type {
  GiteaAccount,
  RepoProject,
  BoardColumn,
  ColumnLabelMap,
  StarredBranch,
} from '../state.js';

// ===== fixtures =====

const now = Date.now();

const accts: GiteaAccount[] = [
  {
    id: 'a1',
    giteaUrl: 'https://gitea.example.com',
    username: 'alice',
    keychainService: 'svc1',
    createdAt: now,
    userInfo: {
      giteaUserId: 42,
      login: 'alice',
      fullName: 'Alice',
      email: 'a@e.com',
      avatarUrl: 'https://avatars/1',
      updatedAt: now,
    },
  },
  {
    id: 'a2',
    giteaUrl: 'https://other.example.com',
    username: 'bob',
    keychainService: 'svc2',
    createdAt: now + 1,
    userInfo: null, // 故意：gitea_user 表还没回填
  },
];

const projects: RepoProject[] = [
  {
    id: 'p1',
    giteaAccountId: 'a1',
    owner: 'org1',
    name: 'web',
    defaultBranch: 'main',
    lastSyncAt: now,
    createdAt: now,
  },
  {
    id: 'p2',
    giteaAccountId: 'a1',
    owner: 'org1',
    name: 'api',
    defaultBranch: 'main',
    lastSyncAt: null,
    createdAt: now + 1,
  },
  {
    id: 'p3',
    giteaAccountId: 'a2',
    owner: 'org2',
    name: 'lib',
    defaultBranch: null,
    lastSyncAt: null,
    createdAt: now + 2,
  },
];

const columns: BoardColumn[] = [
  { id: 'c1', projectId: 'p1', title: '待办', position: 1024, createdAt: now },
  { id: 'c2', projectId: 'p1', title: '进行中', position: 2048, createdAt: now },
  { id: 'c3', projectId: 'p1', title: '已完成', position: 3072, createdAt: now },
  { id: 'c4', projectId: 'p2', title: 'todo', position: 1024, createdAt: now },
];

const labelMaps: ColumnLabelMap[] = [
  { id: 'm1', columnId: 'c1', projectId: 'p1', giteaLabelId: '100', giteaLabelName: 'todo', createdAt: now },
  { id: 'm2', columnId: 'c1', projectId: 'p1', giteaLabelId: '101', giteaLabelName: 'bug', createdAt: now + 1 },
  { id: 'm3', columnId: 'c2', projectId: 'p1', giteaLabelId: '200', giteaLabelName: 'doing', createdAt: now },
];

const starred: StarredBranch[] = [
  { id: 's1', projectId: 'p1', branch: 'main', createdAt: now },
  { id: 's2', projectId: 'p1', branch: 'feature/x', createdAt: now + 1 },
  { id: 's3', projectId: 'p2', branch: 'main', createdAt: now },
];

// ===== accounts =====

describe('listAccountsWithStore', () => {
  it('返 accounts 全部', () => {
    expect(listAccountsWithStore({ accounts: accts })).toEqual(accts);
  });
  it('空账号返空数组', () => {
    expect(listAccountsWithStore({ accounts: [] })).toEqual([]);
  });
});

describe('findAccountByIdWithStore', () => {
  it('命中返 account', () => {
    expect(findAccountByIdWithStore({ accounts: accts }, 'a1')?.username).toBe('alice');
  });
  it('未命中返 null', () => {
    expect(findAccountByIdWithStore({ accounts: accts }, 'nope')).toBeNull();
  });
});

describe('findAccountByUrlAndUsernameWithStore', () => {
  it('命中 (giteaUrl + username) 唯一', () => {
    expect(
      findAccountByUrlAndUsernameWithStore(
        { accounts: accts },
        'https://gitea.example.com',
        'alice',
      )?.id,
    ).toBe('a1');
  });
  it('不命中（url 错）', () => {
    expect(
      findAccountByUrlAndUsernameWithStore(
        { accounts: accts },
        'https://wrong.example.com',
        'alice',
      ),
    ).toBeNull();
  });
});

describe('getFirstAccountWithStore', () => {
  it('返 accounts[0]', () => {
    expect(getFirstAccountWithStore({ accounts: accts })?.id).toBe('a1');
  });
  it('空 accounts 返 null', () => {
    expect(getFirstAccountWithStore({ accounts: [] })).toBeNull();
  });
});

// ===== projects =====

describe('listProjectsByAccountWithStore', () => {
  it('按 giteaAccountId 过滤', () => {
    expect(listProjectsByAccountWithStore({ projects }, 'a1').map((p) => p.id)).toEqual([
      'p1',
      'p2',
    ]);
  });
  it('未匹配返空', () => {
    expect(listProjectsByAccountWithStore({ projects }, 'nope')).toEqual([]);
  });
});

describe('findProjectWithStore', () => {
  it('按 (account, owner, name) 命中', () => {
    expect(
      findProjectWithStore(
        { projects },
        { giteaAccountId: 'a1', owner: 'org1', name: 'web' },
      )?.id,
    ).toBe('p1');
  });
  it('owner 错不命中', () => {
    expect(
      findProjectWithStore(
        { projects },
        { giteaAccountId: 'a1', owner: 'WRONG', name: 'web' },
      ),
    ).toBeNull();
  });
});

describe('findProjectByIdWithStore', () => {
  it('命中', () => {
    expect(findProjectByIdWithStore({ projects }, 'p2')?.name).toBe('api');
  });
});

describe('findProjectsByOwnerNameWithStore', () => {
  it('批量 (owner, name) 命中 → Map<key, project>', () => {
    const m = findProjectsByOwnerNameWithStore(
      { projects },
      'a1',
      [
        { owner: 'org1', name: 'web' },
        { owner: 'org1', name: 'api' },
        { owner: 'org1', name: 'NOTFOUND' },
      ],
    );
    expect(m.size).toBe(2);
    expect(m.get('org1/web')?.id).toBe('p1');
    expect(m.get('org1/api')?.id).toBe('p2');
  });
  it('空 pairs 返空 Map', () => {
    expect(findProjectsByOwnerNameWithStore({ projects }, 'a1', []).size).toBe(0);
  });
  it('跨 account 不串', () => {
    const m = findProjectsByOwnerNameWithStore(
      { projects },
      'a2',
      [{ owner: 'org2', name: 'lib' }],
    );
    expect(m.get('org2/lib')?.giteaAccountId).toBe('a2');
  });
});

// ===== columns =====

describe('listColumnsByProjectWithStore', () => {
  it('按 projectId 过滤 + position 升序', () => {
    expect(
      listColumnsByProjectWithStore({ columns }, 'p1').map((c) => c.id),
    ).toEqual(['c1', 'c2', 'c3']);
  });
  it('跨 project 不串', () => {
    expect(listColumnsByProjectWithStore({ columns }, 'p2').map((c) => c.id)).toEqual([
      'c4',
    ]);
  });
});

describe('maxColumnPositionByProjectWithStore', () => {
  it('返 project 下最大 position', () => {
    expect(maxColumnPositionByProjectWithStore({ columns }, 'p1')).toBe(3072);
  });
  it('空 project 返 -1024（与 POSITION_STEP 对齐）', () => {
    expect(maxColumnPositionByProjectWithStore({ columns }, 'EMPTY')).toBe(-1024);
  });
});

describe('findColumnByIdWithStore', () => {
  it('命中', () => {
    expect(findColumnByIdWithStore({ columns }, 'c2')?.title).toBe('进行中');
  });
  it('未命中 null', () => {
    expect(findColumnByIdWithStore({ columns }, 'nope')).toBeNull();
  });
});

describe('projectExistsInColumnsWithStore', () => {
  it('有列 → true', () => {
    expect(projectExistsInColumnsWithStore({ columns }, 'p1')).toBe(true);
  });
  it('没列 → false', () => {
    expect(projectExistsInColumnsWithStore({ columns }, 'EMPTY')).toBe(false);
  });
});

describe('columnIdsByProjectWithStore', () => {
  it('返 id 集合', () => {
    expect(columnIdsByProjectWithStore({ columns }, 'p1').sort()).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
  });
});

// ===== label-maps =====

describe('listLabelMapsByColumnWithStore', () => {
  it('按 columnId 过滤 + createdAt 升序', () => {
    const m = listLabelMapsByColumnWithStore({ labelMaps }, 'c1');
    expect(m.length).toBe(2);
    expect(m[0]?.giteaLabelId).toBe('100');
    expect(m[1]?.giteaLabelId).toBe('101');
  });
});

describe('findLabelMapByProjectAndLabelWithStore', () => {
  it('命中', () => {
    expect(
      findLabelMapByProjectAndLabelWithStore(
        { labelMaps },
        { projectId: 'p1', giteaLabelId: '200' },
      )?.columnId,
    ).toBe('c2');
  });
  it('labelId 错不命中', () => {
    expect(
      findLabelMapByProjectAndLabelWithStore(
        { labelMaps },
        { projectId: 'p1', giteaLabelId: '999' },
      ),
    ).toBeNull();
  });
});

describe('findLabelMapByColumnAndLabelWithStore', () => {
  it('mapLabel 幂等检查', () => {
    expect(
      findLabelMapByColumnAndLabelWithStore(
        { labelMaps },
        { columnId: 'c1', giteaLabelId: '100' },
      )?.id,
    ).toBe('m1');
  });
});

// ===== starred-branches =====

describe('listStarredBranchesWithStore', () => {
  it('按 projectId 过滤返 Set<branch>', () => {
    const s = listStarredBranchesWithStore({ starredBranches: starred }, 'p1');
    expect(s.size).toBe(2);
    expect(s.has('main')).toBe(true);
    expect(s.has('feature/x')).toBe(true);
  });
  it('跨 project 不串', () => {
    const s = listStarredBranchesWithStore({ starredBranches: starred }, 'p2');
    expect([...s]).toEqual(['main']);
  });
});
