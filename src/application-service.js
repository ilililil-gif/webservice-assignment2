import { AppError, missing, forbidden, invalidState } from './errors.js';

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.
export function createApplicationService(repo) {
  const db=repo.db;

  // 트랜잭션 경계: BEGIN IMMEDIATE로 시작해 쓰기 잠금을 먼저 잡고,
  // 최신 상태 조회·검사·저장을 모두 그 안에서 수행합니다.
  // fn이 정상 반환하면 COMMIT, 업무 거부(AppError)든 저장 오류든 예외가 나면 ROLLBACK 후 다시 던집니다.
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result=fn();
      db.exec('COMMIT');
      return result;
    } catch(e) {
      if(db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  }

  // 같은 행사의 다음 대기자: PENDING만, created_at ASC → id ASC 순서의 첫 1건.
  // CANCELLED·REVOKED·APPROVED와 다른 행사의 신청은 WHERE 조건으로 제외됩니다.
  const nextPendingStmt=db.prepare(`SELECT id FROM applications
    WHERE event_id=? AND status='PENDING' ORDER BY created_at ASC, id ASC LIMIT 1`);

  // 신청 존재(404) → 행사 담당 운영자인지(403) 검사 후 신청을 반환합니다.
  function managedApplication(actor,applicationId) {
    const a=repo.application(applicationId); if(!a) throw missing('신청');
    const e=repo.event(a.eventId);
    if(actor.role!=='MANAGER' || e.managerId!==actor.id) throw forbidden();
    return a;
  }

  return {
    apply(actor,eventId) {
      // TODO-01: 행사·학생 역할·중복 검사 → PENDING 저장 + APPLY 이력.
      // 취소·승인 취소 기록도 중복입니다. 반환: 신청 객체.
      const alreadyApplied=()=>new AppError(409,'ALREADY_APPLIED','이미 이 행사에 신청한 기록이 있습니다.');
      try {
        return transaction(()=>{
          if(!repo.event(eventId)) throw missing('행사');
          if(actor.role!=='STUDENT') throw forbidden();
          if(repo.existing(eventId,actor.id)) throw alreadyApplied(); // 상태와 무관하게 기존 기록이 있으면 중복
          const a=repo.insert(eventId,actor.id);
          repo.addHistory({applicationId:a.id,actorId:actor.id,action:'APPLY',fromStatus:null,toStatus:'PENDING'});
          return a;
        });
      } catch(e) {
        // 서비스 검사를 통과한 뒤 UNIQUE(event_id,user_id) 제약에 걸린 경우(SQLite 확장 오류 코드 2067)도 500이 아닌 409로 응답합니다.
        if(e?.errcode===2067 || /UNIQUE constraint failed/.test(e?.message ?? '')) throw alreadyApplied();
        throw e;
      }
    },
    cancel(actor,applicationId) {
      // TODO-02: 본인의 PENDING만 CANCELLED로 변경 + CANCEL 이력.
      // 학생의 대기 취소는 승인 자리를 비우지 않으므로 자동 승급하지 않습니다.
      return transaction(()=>{
        const a=repo.application(applicationId); if(!a) throw missing('신청');
        if(actor.role!=='STUDENT' || a.userId!==actor.id) throw forbidden();
        if(a.status!=='PENDING') throw invalidState();
        const updated=repo.setStatus(a.id,'CANCELLED');
        repo.addHistory({applicationId:a.id,actorId:actor.id,action:'CANCEL',fromStatus:'PENDING',toStatus:'CANCELLED'});
        return updated;
      });
    },
    approve(actor,applicationId) {
      // TODO-03: 담당자·PENDING·정원 검사 → APPROVED + APPROVE 이력.
      // 직접 승인은 운영자가 선택합니다. FIFO는 승인 취소 때의 자동 승급에 적용합니다.
      return transaction(()=>{
        const a=managedApplication(actor,applicationId);
        if(a.status!=='PENDING') throw invalidState();
        const e=repo.event(a.eventId);
        if(repo.approvedCount(a.eventId)>=e.capacity) throw new AppError(409,'CAPACITY_FULL','행사 정원이 가득 찼습니다.');
        const updated=repo.setStatus(a.id,'APPROVED');
        repo.addHistory({applicationId:a.id,actorId:actor.id,action:'APPROVE',fromStatus:'PENDING',toStatus:'APPROVED'});
        return updated;
      });
    },
    revoke(actor,applicationId,reason) {
      // TODO-04: 담당자·APPROVED 검사 → REVOKED + REVOKE 이력.
      // 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1건을 자동 승인합니다.
      // AUTO_APPROVE 이력의 causeHistoryId는 이 요청의 REVOKE 이력 ID입니다.
      // 상태와 이력의 부분 저장을 막고, 거부·오류 시 전체를 되돌리세요.
      // 반환: {revoked: 신청 객체, promoted: 신청 객체 또는 null}.
      return transaction(()=>{
        // 1. 최신 대상과 권한·상태 확인
        const a=managedApplication(actor,applicationId);
        if(a.status!=='APPROVED') throw invalidState();
        // 2. REVOKED 변경 + REVOKE 이력 (reason은 app.js에서 trim·길이 검사 완료)
        const revoked=repo.setStatus(a.id,'REVOKED');
        const revokeHistoryId=repo.addHistory({applicationId:a.id,actorId:actor.id,action:'REVOKE',
          fromStatus:'APPROVED',toStatus:'REVOKED',reason});
        // 3. 같은 행사 대기자 중 다음 한 명 선택 (요청당 최대 1명)
        const next=nextPendingStmt.get(a.eventId);
        let promoted=null;
        if(next) {
          // 4. 자동 승인 + AUTO_APPROVE 이력(원인 = 이번 REVOKE 이력)
          promoted=repo.setStatus(next.id,'APPROVED');
          repo.addHistory({applicationId:next.id,actorId:actor.id,action:'AUTO_APPROVE',
            fromStatus:'PENDING',toStatus:'APPROVED',causeHistoryId:revokeHistoryId});
        }
        // 5. 여기까지 모두 성공하면 transaction()이 COMMIT, 중간 오류 시 전체 ROLLBACK
        return {revoked,promoted};
      });
    }
  };
}
