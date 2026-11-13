const actions = {
  call: { title: "Call / follow up", kind: "call" },
  send_details: { title: "Send product details", kind: "send_details" },
  confirm_meeting: { title: "Confirm meeting time", kind: "confirm_meeting" },
  after_meeting: { title: "Follow up after meeting", kind: "call" },
  proposal: { title: "Follow up on proposal", kind: "call" },
  partner: { title: "Check partner decision", kind: "call" },
};
export function selectedAction(body, fallback = "call") {
  if (body.nextAction && !actions[body.nextAction])
    throw Object.assign(new Error("Choose a valid next action"), {
      status: 422,
    });
  return actions[body.nextAction || fallback];
}
