// Only completed, nonempty pairs belong in the next provider request.
export function chatHistory(messages, question) {
  const pairs=[];
  for(let i=0;i<messages.length;i++) {
    const user=messages[i],model=messages[i+1];
    if(user.role==='user'&&model?.role==='model') {
      if(user.text?.trim()&&model.text?.trim())pairs.push([
        {role:'user',text:user.text.trim().slice(0,4000)},
        {role:'model',text:model.text.trim().slice(0,4000)},
      ]);
      i++;
    }
  }
  const history=pairs.slice(-6).flat();
  while(history.length&&history.reduce((sum,item)=>sum+item.text.length,0)+question.length>24000)history.splice(0,2);
  return [...history,{role:'user',text:question}];
}

export function completedAnswer(data, streamed='') {
  const answer=typeof data?.text==='string'&&data.text.trim()?data.text.trim():streamed.trim();
  if(!answer)throw new Error('AI가 답변을 만들지 못했습니다. 다시 질문해 주세요.');
  return answer;
}
