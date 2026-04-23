/**
 * Claude plan exit workflow card templates.
 *
 * When the user exits plan mode, these cards are displayed
 * to summarize the plan state and offer next steps.
 */

export function buildPlanExitConfirmationCard(): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: '📋 Plan Mode Exit',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: 'You are exiting plan mode. The agent will now execute the approved plan.\n\n**What happens next:**\n• The agent will follow the plan you approved\n• You will receive progress updates\n• The agent may still ask for permission on risky operations',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '✅ Execute Plan',
            },
            type: 'primary',
            value: {
              callback: 'planexit:confirm:execute',
            },
          },
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '🔄 Back to Plan',
            },
            type: 'default',
            value: {
              callback: 'planexit:back:plan',
            },
          },
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '❌ Cancel',
            },
            type: 'danger',
            value: {
              callback: 'planexit:cancel',
            },
          },
        ],
        layout: 'vertical',
      },
    ],
  };
}

export function buildPlanExecutionStartedCard(): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'green',
      title: {
        tag: 'plain_text',
        content: '✅ Plan Execution Started',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: 'The agent is now executing the approved plan. You will receive progress updates as it completes each step.',
      },
    ],
  };
}
